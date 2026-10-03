/* v8 ignore file — type-only module, no runtime statements. */

/**
 * Data model for the in-app help sidebar. Help topics are plain static data:
 * the drawer resolves a topic id from the current route (see `keys.ts`) and
 * renders these structures. Content ships in English, matching the rest of
 * the UI — no i18n layer exists in the app.
 */

/** One logical block of help content inside a topic. */
export interface HelpSection {
  heading: string;
  /** Short paragraphs explaining what this area or operation is. */
  body?: string[];
  /** Ordered how-to steps, rendered as a numbered list. */
  steps?: string[];
  /** Unordered facts, field explanations or options. */
  bullets?: string[];
  /** Highlighted tip or warning rendered as a callout. */
  tip?: string;
}

/** A link from one topic to another topic in the drawer. */
export interface HelpLink {
  label: string;
  /** id of the target entry in HELP_TOPICS. */
  helpId: string;
}

export interface HelpTopic {
  title: string;
  /** One-or-two sentence answer to "what is this page?". */
  summary: string;
  sections: HelpSection[];
  /** Pointers to closely related topics, rendered at the end of the topic. */
  related?: HelpLink[];
}
