/**
 * The plugin stylesheet, hand-written as a template string and injected once by
 * the plugin body: the web server serves exactly one file per client plugin, so
 * no separate CSS artifact may exist (same constraint as dsh-at-file).
 *
 * Colours and geometry come only from the shared `--dsw-*` design platform, so
 * light and dark themes both work without a single literal colour (AC-10).
 * Class names carry the `dsh_promptLibrary_` prefix to stay unique in the
 * assembled shell.
 */

/** Stable `<style>` element id (idempotent injection across HMR re-runs). */
const STYLE_ID = 'dsh-prompt-library-style';

/** The plugin's injected stylesheet text. */
const cssText = `
/* The chip row shares the composer's content column (design §12.3).
 *
 * The dock slot renders as a direct child of the platform's composerStack
 * (dsh-client-ui-conversation/lib/client.js:7269), which spans the WHOLE
 * conversation column, while the input card inside it is a centred column:
 * root{padding:0 var(--dsh-composer-side-clearance)} +
 * card{width:100%;max-width:var(--dsh-composer-card-max-width)}
 * (same bundle -> InputBar css, .uV2eYG_root / .uV2eYG_card). These three
 * declarations are exactly the ones dsh-at-file's FilesDock uses for the same
 * slot (.dsh_atFile_rail), so the row's left/right edges land on the input
 * card's edges at every width:
 *   width: calc(100% - 2 * clearance)   == card width inside the padded root
 *   max-width: composer-card-max-width  == the card's own cap
 *   margin: 0 auto                      == the card's centring
 * The horizontal padding is 0 so a chip's edge is the row's edge. */
.dsh_promptLibrary_chips {
  box-sizing: border-box;
  display: flex;
  flex: none;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  width: calc(
    100% -
    var(--dsh-composer-side-clearance, 16px) -
    var(--dsh-composer-side-clearance, 16px)
  );
  max-width: var(--dsh-composer-card-max-width, 780px);
  min-width: 0;
  margin: 0 auto;
  padding: 4px 0 6px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
.dsh_promptLibrary_chip {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
  max-width: 240px;
  padding: 1px 2px 1px 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-bg-layer-1);
}
.dsh_promptLibrary_chipTitle,
.dsh_promptLibrary_chipRemove {
  border: 0;
  background: transparent;
  font: inherit;
  color: inherit;
  cursor: pointer;
  padding: 0;
}
.dsh_promptLibrary_chipTitle {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-primary);
}
.dsh_promptLibrary_chipTitle:hover {
  color: var(--dsw-alias-brand-primary);
}
.dsh_promptLibrary_chipRemove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: var(--dsw-radius-xs);
  color: var(--dsw-alias-label-tertiary);
  font-size: 13px;
  line-height: 1;
}
.dsh_promptLibrary_chipRemove:hover {
  background: var(--dsw-alias-interactive-bg-hover-danger);
  color: var(--dsw-alias-label-primary);
}
.dsh_promptLibrary_chipTotal {
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
}

/* Modal backdrop (design §12.2). inset: 0 is only what paints before the
 * first measurement: the dialog measures itself plus the conversation content
 * area and writes the resulting left/top/width/height inline
 * (dialog.js -> placeOverlay). Measuring is not optional — the composer
 * subtree generates a CONTAINING BLOCK for fixed descendants in DSH 0.2.2
 * (will-change: transform on .an3WzG_composerSeat), so viewport arithmetic
 * would drop the dialog under the input box instead of over the conversation.
 * visibility: visible below keeps the modal painted when the platform hides
 * the composer mid-animation ([data-phase=settling] sets visibility:hidden on
 * the seat; visibility is inherited, but a descendant may override it).
 * The 16px padding is the promised minimum margin: on a narrow content area
 * the dialog shrinks (width: min(680px, 100%)) and keeps 16px on every side. */
.dsh_promptLibrary_backdrop {
  position: fixed;
  inset: 0;
  z-index: 1200;
  visibility: visible;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 12%, transparent);
}
.dsh_promptLibrary_dialog {
  display: flex;
  flex-direction: column;
  gap: 12px;
  box-sizing: border-box;
  width: min(680px, 100%);
  max-height: min(760px, 100%);
  overflow: auto;
  padding: 20px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: var(--dsw-shadow-lv3);
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 20px;
}
.dsh_promptLibrary_dialogHead {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.dsh_promptLibrary_dialogTitle {
  margin: 0;
  font-size: 15px;
  line-height: 22px;
  font-weight: 600;
}
.dsh_promptLibrary_hint {
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}
.dsh_promptLibrary_tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.dsh_promptLibrary_tag {
  padding: 0 6px;
  border-radius: var(--dsw-radius-xs);
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  line-height: 18px;
}
.dsh_promptLibrary_textarea,
.dsh_promptLibrary_input {
  box-sizing: border-box;
  width: 100%;
  padding: 8px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  resize: vertical;
}
.dsh_promptLibrary_textarea {
  min-height: 220px;
  line-height: 1.5;
}
.dsh_promptLibrary_textarea:focus,
.dsh_promptLibrary_input:focus {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: -1px;
}
.dsh_promptLibrary_delivery {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.dsh_promptLibrary_option {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.dsh_promptLibrary_option[aria-pressed='true'] {
  border-color: var(--dsw-alias-brand-primary);
  background: var(--dsw-alias-interactive-bg-hover);
}
.dsh_promptLibrary_option:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}
.dsh_promptLibrary_optionTitle {
  font-weight: 600;
}
.dsh_promptLibrary_foot {
  display: flex;
  align-items: center;
  gap: 8px;
}
.dsh_promptLibrary_foot .dsh_promptLibrary_spacer {
  flex: 1;
}
.dsh_promptLibrary_button {
  padding: 6px 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  cursor: pointer;
}
.dsh_promptLibrary_button:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
}
.dsh_promptLibrary_button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
.dsh_promptLibrary_buttonPrimary {
  border-color: transparent;
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-inverted);
}
.dsh_promptLibrary_buttonPrimary:hover:not(:disabled) {
  background: var(--dsw-alias-button-primary-fill);
  opacity: 0.9;
}
.dsh_promptLibrary_buttonDanger {
  border-color: var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-state-error-primary);
  background: transparent;
}
.dsh_promptLibrary_message {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
.dsh_promptLibrary_error {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-state-error-primary);
}

.dsh_promptLibrary_section {
  display: flex;
  flex-direction: column;
  gap: 14px;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 20px;
}
.dsh_promptLibrary_sectionHead {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.dsh_promptLibrary_sectionTitle {
  margin: 0;
  font-size: 16px;
  line-height: 24px;
  font-weight: 600;
}
.dsh_promptLibrary_toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.dsh_promptLibrary_toolbar .dsh_promptLibrary_input {
  width: auto;
  min-width: 200px;
  flex: 1;
}
.dsh_promptLibrary_path {
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 16px;
  overflow-wrap: anywhere;
}
.dsh_promptLibrary_banner {
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-interactive-bg-hover);
  font-size: 12px;
  line-height: 18px;
}
.dsh_promptLibrary_table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.dsh_promptLibrary_table th {
  text-align: left;
  font-weight: 500;
  color: var(--dsw-alias-label-tertiary);
  padding: 4px 8px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.dsh_promptLibrary_table td {
  padding: 6px 8px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  vertical-align: top;
}
.dsh_promptLibrary_cellTitle {
  font-weight: 500;
}
.dsh_promptLibrary_cellBody {
  color: var(--dsw-alias-label-tertiary);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.dsh_promptLibrary_rowActions {
  display: flex;
  gap: 4px;
  justify-content: flex-end;
}
.dsh_promptLibrary_empty {
  padding: 16px 8px;
  color: var(--dsw-alias-label-tertiary);
}
.dsh_promptLibrary_form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-sm);
}
.dsh_promptLibrary_field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.dsh_promptLibrary_fieldLabel {
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
}
.dsh_promptLibrary_importBox {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-sm);
}
.dsh_promptLibrary_confirm {
  display: flex;
  align-items: center;
  gap: 8px;
}
`;

/** Inject the plugin stylesheet once (stable id; HMR-safe). */
export function adoptStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID) !== null) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.dataset.plugin = 'dsh-prompt-library';
  style.dataset.pluginCss = STYLE_ID;
  style.textContent = cssText;
  document.head.appendChild(style);
}
