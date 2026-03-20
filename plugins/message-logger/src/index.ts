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
storage.deletedMessages ??= {};

const deletedMessages = () => (storage.deletedMessages ??= {});

const getStoredChannel = (channelId) => {
  if (!channelId) return;
  return deletedMessages()[channelId] ??= {};
};

const removeStoredMessage = (channelId, messageId) => {
  const channel = deletedMessages()[channelId];
  if (!channel) return;

  delete channel[messageId];
  if (!Object.keys(channel).length) delete deletedMessages()[channelId];
};

const serializeMessage = (message) => ({
  ...(typeof message.toJS === "function" ? message.toJS() : message),
  __vml_deleted: true,
  __vml_savedAt: Date.now(),
});

const getCachedChannel = (channelId) => ChannelMessages.get(channelId) ?? ChannelMessages._channelMessages?.[channelId];

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

const restoreChannel = (channelId) => {
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
      message: {
        ...message,
        __vml_deleted: true,
      },
      optimistic: false,
      __vml_restore: true,
    });
  }
};

patches.push(before("dispatch", FluxDispatcher, ([event]) => {
  if (event.type === "MESSAGE_DELETE") {
    if (event.__vml_cleanup) {
      if (event.__vml_forget) removeStoredMessage(event.channelId, event.id);
      return event;
    }

    const channel = ChannelMessages.get(event.channelId);
    const message = channel?.get(event.id);
    if (!message) return event;

    if (message.author?.id == "1") return event;
    if (message.state == "SEND_FAILED") return event;

    const deletedMessage = serializeMessage(message);
    getStoredChannel(message.channel_id)[message.id] = deletedMessage;

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
  }
}));

patches.push(instead("updateMessageRecord", MessageRecordUtils, function ([oldRecord, newRecord], orig) {
  if (newRecord.__vml_deleted) {
    return MessageRecordUtils.createMessageRecord(newRecord, oldRecord.reactions);
  }
  return orig.apply(this, [oldRecord, newRecord]);
}));

patches.push(after("createMessageRecord", MessageRecordUtils, function ([message], record) {
  record.__vml_deleted = message.__vml_deleted;
  // record.__vml_edits = message.__vml_edits;
}));

patches.push(after("default", MessageRecord, ([props], record) => {
  record.__vml_deleted = !!props.__vml_deleted;
  // record.__vml_edits = props.__vml_edits;
}));

export const onLoad = () => {
  deletedMessages();

  for (const channelId in ChannelMessages._channelMessages ?? {}) {
    restoreChannel(channelId);
  }
};

export const onUnload = () => {
  patches.forEach((unpatch) => unpatch());

  for (const channelId in ChannelMessages._channelMessages) {
    for (const message of ChannelMessages._channelMessages[channelId]._array) {
      message.__vml_deleted && FluxDispatcher.dispatch({
        type: "MESSAGE_DELETE",
        id: message.id,
        channelId: message.channel_id,
        __vml_cleanup: true,
      });
    }
  }
};

export { default as settings } from "./settings";
