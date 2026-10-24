// The skin catalog (M5): one folder per client, assembled here into
// `Skin` entries that bind the shared sure-ui theme and component runs. The
// D6 build order is Gmail, Outlook Online, Mac Mail, Thunderbird.
import type { SkinSpec } from "../types.ts";
import { gmailSkin } from "./gmail/index.ts";
import { macmailSkin } from "./macmail/index.ts";
import { outlookSkin } from "./outlook/index.ts";
import { thunderbirdSkin } from "./thunderbird/index.ts";

/** The four Track B skin folders, in registration (D6) order. */
export const SKIN_MODULES: readonly SkinSpec[] = [gmailSkin, outlookSkin, macmailSkin, thunderbirdSkin];
