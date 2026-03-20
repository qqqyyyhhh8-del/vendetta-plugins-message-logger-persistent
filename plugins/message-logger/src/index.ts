import { findByName, findByProps } from "@vendetta/metro";
import { FluxDispatcher, ReactNative } from "@vendetta/metro/common";
import { after, before, instead } from "@vendetta/patcher";
import { storage } from "@vendetta/plugin";

const patches = [];
const ChannelMessages = findByProps("_channelMessages");
const MessageRecordUtils = findByProps("updateMessageRecord", "createMessageRecord");
const MessageRecord = findByName("MessageRecord", false);
const RowManager = findByName("RowManager");
const LOAD_EVENTS = new Set([
  "LOAD_MESSAGES_AROUND_SUCCESS",
  "LOAD_MESSAGES_SUCCESS",
  "LOAD_MESSAGES_SUCCESS_CACHED",
]);

storage.nopk ??= false;
storage.logEdits ??= true;
storage.deletedMessages ??= {};
storage.editedMessages ??= {};

const deletedMessages = () => (storage.deletedMessages ??= {});
const editedMessages = () => (storage.editedMessages ??= {});
const normalizeContent = (content) => typeof content === "string" ? content : "";
const cloneEdits = (edits = []) => edits.map((edit) => ({
  ...edit,
  content: normalizeContent(edit.content),
}));

const getStoredChannel = (store, channelId) => {
  if (!channelId) return;
  return store()[channelId] ??= {};
};

const removeStoredMessage = (store, channelId, messageId) => {
  const channel = store()[channelId];
  if (!channel) return;

  delete channel[messageId];
  if (!Object.keys(channel).length) delete store()[channelId];
};

const cloneMessage = (message) => {
  const base = typeof message?.toJS === "function" ? message.toJS() : { ...message };

  if (message?.__vml_deleted) base.__vml_deleted = true;
  if (message?.__vml_savedAt) base.__vml_savedAt = message.__vml_savedAt;
  if (message?.__vml_currentContent !== undefined) base.__vml_currentContent = message.__vml_currentContent;
  if (message?.__vml_edits?.length) base.__vml_edits = cloneEdits(message.__vml_edits);

  return base;
};

const getRawContent = (message) => normalizeContent(message?.__vml_currentContent ?? message?.content);
const getVisibleContent = (content) => {
  const raw = normalizeContent(content);
  return raw.length ? raw : "(empty)";
};
const formatTimestamp = (timestamp) => new Date(timestamp ?? Date.now()).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "Z");
const formatHistoryEntry = (edit, index) => {
  const lines = getVisibleContent(edit.content).split("\n").map((line) => `> ${line || " "}`).join("\n");
  return `[#${index + 1} ${formatTimestamp(edit.editedAt)}]\n${lines}`;
};
const buildEditHistoryText = (edits) => edits.length
  ? `\n\n[Edit History]\n${edits.map((edit, index) => formatHistoryEntry(edit, index)).join("\n")}`
  : "";

const applyMessageHistory = (message, extra = {}) => {
  const base = cloneMessage(message);
  const edits = cloneEdits(extra.__vml_edits ?? base.__vml_edits ?? []);
  const rawContent = normalizeContent(extra.__vml_currentContent ?? base.__vml_currentContent ?? base.content);

  return {
    ...base,
    ...extra,
    content: edits.length ? `${getVisibleContent(rawContent)}${buildEditHistoryText(edits)}` : rawContent,
    __vml_currentContent: rawContent,
    __vml_edits: edits,
  };
};

const stripLoggedMessage = (message) => {
  const cleanMessage = cloneMessage(message);

  cleanMessage.content = getRawContent(cleanMessage);
  delete cleanMessage.__vml_deleted;
  delete cleanMessage.__vml_savedAt;
  delete cleanMessage.__vml_currentContent;
  delete cleanMessage.__vml_edits;

  return cleanMessage;
};

const serializeDeletedMessage = (message) => ({
  ...applyMessageHistory(message),
  __vml_deleted: true,
  __vml_savedAt: Date.now(),
});

const serializeEdit = (message) => ({
  content: getRawContent(message),
  editedAt: Date.now(),
});

const getCachedChannel = (channelId) => ChannelMessages.get(channelId) ?? ChannelMessages._channelMessages?.[channelId];
const getCachedMessage = (channelId, messageId) => {
  const channel = getCachedChannel(channelId);
  if (!channel) return;
  if (typeof channel.get === "function") return channel.get(messageId);
  if (channel._map?.[messageId]) return channel._map[messageId];
  return channel._array?.find((message) => message.id === messageId);
};

const hasMessage = (channel, messageId) => {
  if (!channel) return false;
  if (typeof channel.get === "function") return !!channel.get(messageId);
  if (channel._map?.[messageId]) return true;
  return channel._array?.some((message) => message.id === messageId) ?? false;
};

const getMessageSortValue = (message) => {
  const value = new Date(message.timestamp ?? 0).getTime();
  return Number.isFinite(value) ? value : 0;
};

const storeEditedMessage = (channelId, messageId, edits, currentContent) => {
  const channel = getStoredChannel(editedMessages, channelId);
  if (!channel) return;

  channel[messageId] = {
    currentContent: normalizeContent(currentContent),
    edits: cloneEdits(edits),
  };
};

const restoreDeletedChannel = (channelId) => {
  const stored = deletedMessages()[channelId];
  const channel = getCachedChannel(channelId);
  if (!stored || !channel) return;

  const seen = new Set(channel._array?.map((message) => message.id) ?? []);

  for (const message of Object.values(stored).sort((a, b) => getMessageSortValue(a) - getMessageSortValue(b))) {
    if (seen.has(message.id) || hasMessage(channel, message.id)) continue;

    seen.add(message.id);
    FluxDispatcher.dispatch({
      type: "MESSAGE_CREATE",
      channelId,
      message: applyMessageHistory(message, {
        __vml_deleted: true,
      }),
      optimistic: false,
      __vml_restore: true,
    });
  }
};

const restoreEditedChannel = (channelId) => {
  if (!storage.logEdits) return;

  const stored = editedMessages()[channelId];
  if (!stored) return;

  for (const [messageId, entry] of Object.entries(stored)) {
    const message = getCachedMessage(channelId, messageId);
    if (!message || message.__vml_deleted) continue;

    const cachedEdits = cloneEdits(message.__vml_edits ?? []);
    const lastCachedEdit = cachedEdits[cachedEdits.length - 1];
    const lastStoredEdit = entry.edits[entry.edits.length - 1];
    const sameState = cachedEdits.length === entry.edits.length
      && getRawContent(message) === normalizeContent(entry.currentContent)
      && lastCachedEdit?.content === lastStoredEdit?.content
      && lastCachedEdit?.editedAt === lastStoredEdit?.editedAt;

    if (sameState) continue;

    FluxDispatcher.dispatch({
      type: "MESSAGE_UPDATE",
      message: applyMessageHistory(message, {
        __vml_currentContent: entry.currentContent,
        __vml_edits: entry.edits,
      }),
      __vml_restore_edit: true,
    });
  }
};

const restoreChannel = (channelId) => {
  restoreDeletedChannel(channelId);
  restoreEditedChannel(channelId);
};

patches.push(before("dispatch", FluxDispatcher, ([event]) => {
  if (event.type === "MESSAGE_DELETE") {
    if (event.__vml_cleanup) {
      if (event.__vml_forget) {
        removeStoredMessage(deletedMessages, event.channelId, event.id);
        removeStoredMessage(editedMessages, event.channelId, event.id);
      }
      return;
    }

    const message = getCachedMessage(event.channelId, event.id);
    if (!message) return;

    if (message.author?.id == "1") return;
    if (message.state == "SEND_FAILED") return;

    const deletedMessage = serializeDeletedMessage(message);
    getStoredChannel(deletedMessages, deletedMessage.channel_id)[deletedMessage.id] = deletedMessage;
    removeStoredMessage(editedMessages, deletedMessage.channel_id, deletedMessage.id);

    storage.nopk && fetch(`https://api.pluralkit.me/v2/messages/${encodeURIComponent(message.id)}`)
      .then((res) => res.json())
      .then((data) => {
        if (message.id === data.original && !data.member?.keep_proxy) {
          FluxDispatcher.dispatch({
            type: "MESSAGE_DELETE",
            id: message.id,
            channelId: message.channel_id,
            __vml_cleanup: true,
            __vml_forget: true,
          });
        }
      })
      .catch(() => {});

    return [{
      message: deletedMessage,
      type: "MESSAGE_UPDATE",
    }];
  }

  if (event.type === "MESSAGE_UPDATE") {
    if (!storage.logEdits || event.__vml_restore_edit) return;
    if (!event.message?.id || event.message.content === undefined) return;

    const channelId = event.message.channel_id ?? event.channelId;
    const oldMessage = getCachedMessage(channelId, event.message.id);
    if (!oldMessage || oldMessage.__vml_deleted) return;

    if (oldMessage.author?.id == "1") return;
    if (oldMessage.state == "SEND_FAILED") return;

    const oldRawContent = getRawContent(oldMessage);
    const newRawContent = normalizeContent(event.message.content);
    if (oldRawContent === newRawContent) return;

    const previousEdits = cloneEdits(oldMessage.__vml_edits ?? editedMessages()[channelId]?.[event.message.id]?.edits ?? []);
    const nextEdits = [...previousEdits, serializeEdit(oldMessage)];
    const mergedMessage = {
      ...cloneMessage(oldMessage),
      ...cloneMessage(event.message),
    };

    storeEditedMessage(channelId, event.message.id, nextEdits, newRawContent);

    return [{
      ...event,
      message: applyMessageHistory(mergedMessage, {
        __vml_currentContent: newRawContent,
        __vml_edits: nextEdits,
      }),
    }];
  }
}));

patches.push(after("dispatch", FluxDispatcher, ([event]) => {
  if (!LOAD_EVENTS.has(event.type)) return;

  const channelId = event.channelId ?? event.messages?.[0]?.channel_id;
  if (!channelId) return;

  setTimeout(() => restoreChannel(channelId), 0);
}));

patches.push(after("generate", RowManager.prototype, ([data], row) => {
  if (data.rowType !== 1) return;

  if (data.message.__vml_deleted) {
    row.message.edited = "deleted";
    row.backgroundHighlight ??= {};
    row.backgroundHighlight.backgroundColor = ReactNative.processColor("#da373c22");
    row.backgroundHighlight.gutterColor = ReactNative.processColor("#da373cff");
    return;
  }

  if (data.message.__vml_edits?.length) {
    row.message.edited = `edited (${data.message.__vml_edits.length})`;
    row.backgroundHighlight ??= {};
    row.backgroundHighlight.backgroundColor = ReactNative.processColor("#2f6feb22");
    row.backgroundHighlight.gutterColor = ReactNative.processColor("#2f6febff");
  }
}));

patches.push(instead("updateMessageRecord", MessageRecordUtils, function ([oldRecord, newRecord], orig) {
  if (newRecord.__vml_deleted || newRecord.__vml_edits?.length) {
    return MessageRecordUtils.createMessageRecord(newRecord, oldRecord.reactions);
  }
  return orig.apply(this, [oldRecord, newRecord]);
}));

patches.push(after("createMessageRecord", MessageRecordUtils, function ([message], record) {
  record.__vml_deleted = !!message.__vml_deleted;
  record.__vml_currentContent = message.__vml_currentContent;
  record.__vml_edits = cloneEdits(message.__vml_edits ?? []);
}));

patches.push(after("default", MessageRecord, ([props], record) => {
  record.__vml_deleted = !!props.__vml_deleted;
  record.__vml_currentContent = props.__vml_currentContent;
  record.__vml_edits = cloneEdits(props.__vml_edits ?? []);
}));

export const onLoad = () => {
  deletedMessages();
  editedMessages();

  for (const channelId in ChannelMessages._channelMessages ?? {}) {
    restoreChannel(channelId);
  }
};

export const onUnload = () => {
  patches.forEach((unpatch) => unpatch());

  for (const channelId in ChannelMessages._channelMessages ?? {}) {
    for (const message of ChannelMessages._channelMessages[channelId]._array ?? []) {
      if (message.__vml_deleted) {
        FluxDispatcher.dispatch({
          type: "MESSAGE_DELETE",
          id: message.id,
          channelId: message.channel_id,
          __vml_cleanup: true,
        });
        continue;
      }

      if (message.__vml_edits?.length) {
        FluxDispatcher.dispatch({
          type: "MESSAGE_UPDATE",
          message: stripLoggedMessage(message),
          __vml_cleanup: true,
        });
      }
    }
  }
};

export { default as settings } from "./settings";
