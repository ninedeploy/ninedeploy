const PANEL_FIELD_SELECTOR = [
  'input:not([type="checkbox"]):not([type="radio"]):not([type="file"]):not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="reset"])',
  'textarea',
].join(',');

export function hardenPanelField(field: HTMLInputElement | HTMLTextAreaElement): void {
  field.setAttribute('autocomplete', 'off');
  field.setAttribute('autocorrect', 'off');
  field.setAttribute('autocapitalize', 'none');
  field.setAttribute('spellcheck', 'false');
  field.setAttribute('data-1p-ignore', 'true');
  field.setAttribute('data-lpignore', 'true');
  field.setAttribute('data-bwignore', 'true');
  field.setAttribute('data-form-type', 'other');
}

export function rejectPanelAutofill(field: HTMLInputElement, onRejected?: () => void): void {
  field.value = '';
  onRejected?.();
}

function hardenTree(root: ParentNode): void {
  if (root instanceof HTMLInputElement || root instanceof HTMLTextAreaElement) {
    if (root.matches(PANEL_FIELD_SELECTOR)) hardenPanelField(root);
    return;
  }
  for (const field of root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(PANEL_FIELD_SELECTOR)) {
    hardenPanelField(field);
  }
}

/**
 * Enforce the no-autofill policy for every authenticated panel field,
 * including raw inputs and fields added later by dialogs or plugins.
 */
export function installPanelAutofillGuard(root: ParentNode): () => void {
  hardenTree(root);
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof Element) hardenTree(node);
      }
    }
  });
  observer.observe(root, { childList: true, subtree: true });
  return () => observer.disconnect();
}
