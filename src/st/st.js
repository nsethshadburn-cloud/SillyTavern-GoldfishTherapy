// The one place that imports SillyTavern internals. Everything else goes through here,
// so if a SillyTavern update moves something, only this file needs fixing.
// Served from /scripts/extensions/third-party/<folder>/src/st/

import {
    is_send_press,
    chat,
    chat_metadata,
    characters,
    this_chid,
    eventSource,
    event_types,
    saveSettingsDebounced,
    saveChatConditional,
    updateMessageBlock,
    setExtensionPrompt,
    extension_prompt_types,
    extension_prompt_roles,
    generateRaw,
    substituteParams,
    name1,
    name2,
    main_api,
    max_context,
    amount_gen,
    getCurrentChatId,
    syncMesToSwipe,
} from '../../../../../../script.js';
import { extension_settings, saveMetadataDebounced } from '../../../../../extensions.js';
import { selected_group, is_group_generating } from '../../../../../group-chats.js';
import { power_user } from '../../../../../power-user.js';
import { callGenericPopup, POPUP_TYPE } from '../../../../../popup.js';

export const MODULE = 'goldfish_therapy';

export const ST = {
    get chat() { return chat; },
    get chatMetadata() { return chat_metadata; },
    get chatId() { return String(getCurrentChatId() ?? ''); },
    get character() { return selected_group ? null : (characters[this_chid] ?? null); },
    get isBusy() { return Boolean(is_send_press || is_group_generating); },
    get userName() { return name1; },
    get charName() { return name2; },
    get mainApi() { return main_api; },
    get maxContext() { return Number(max_context) || 0; },
    get responseLength() { return Number(amount_gen) || 0; },
    get powerUser() { return power_user; },
    get extensionSettings() { return extension_settings; },
    eventSource,
    eventTypes: event_types,
    saveSettingsDebounced,
    saveChat: saveChatConditional,
    saveMetadataDebounced,
    updateMessageBlock,
    syncMesToSwipe,
    setExtensionPrompt,
    promptTypes: extension_prompt_types,
    promptRoles: extension_prompt_roles,
    generateRaw,
    substituteParams,
    callGenericPopup,
    POPUP_TYPE,
    context: () => SillyTavern.getContext(),
};
