import { ReactNative } from "@vendetta/metro/common";
import { Forms } from "@vendetta/ui/components";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { storage } from "@vendetta/plugin";
import { useProxy } from "@vendetta/storage";

const { FormIcon, FormSwitchRow } = Forms;

storage.nopk ??= false;
storage.logEdits ??= true;

export default () => {
  useProxy(storage);

  return (
    <ReactNative.ScrollView>
      <FormSwitchRow
        label="Track Edit History"
        subLabel="Keep previous message versions and show them inline."
        leading={<FormIcon source={getAssetIDByName("ic_edit_24px")} />}
        onValueChange={(v) => void (storage.logEdits = v)}
        value={storage.logEdits}
      />
      <FormSwitchRow
        label="Ignore PluralKit"
        leading={<FormIcon source={getAssetIDByName("ic_block")} />}
        onValueChange={(v) => void (storage.nopk = v)}
        value={storage.nopk}
      />
    </ReactNative.ScrollView>
  );
};
