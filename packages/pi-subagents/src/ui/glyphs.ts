/**
 * glyphs.ts — the semantic display-glyph vocabulary for the agent UI.
 *
 * Pi's TUI sizes each terminal cell with `get-east-asian-width`, which reports
 * one cell for every glyph below. A glyph that no monospace font covers is
 * therefore drawn by a proportional fallback font whose advance overruns that
 * cell and collides with the next column — the defect in #669. East Asian Width
 * does not detect this: the offending glyph and its replacement are both width 1.
 *
 * Before adding or changing a glyph, measure its monospace coverage:
 *
 *   fc-list ":charset=<codepoint>:spacing=100" family | cut -d, -f1 | sort -u | grep -v LastResort
 *
 * Coverage on macOS 15, counted in families:
 *
 *   ↻ U+21BB turns          1  (Menlo)
 *   ⇊ U+21CA compactions    1  (Menlo)
 *   ✓ U+2713 success        6
 *   ✗ U+2717 failure        6
 *   ▸ U+25B8 tool call      6
 *   ■ U+25A0 stopped        9
 *   ● U+25CF agents active  9
 *   ○ U+25CB agents idle    9
 *   ◦ U+25E6 queued         9
 *   ⎿ U+23BF sub-line       0  — pi house style, tracked in #683
 *   ◍ U+25CD streaming      1  (Menlo), tracked in #683
 *   ⠋…⠏ spinner frames      0  — pi house style, tracked in #683
 *
 * Glyphs are written here as literal characters rather than `\uXXXX` escapes, so
 * a non-ASCII scan of `src/` (`rg -n '[^\x00-\x7f]' src --glob '*.ts'`) surfaces
 * this file plus only layout and punctuation. Box-drawing characters stay at
 * their render sites: they are layout, not vocabulary.
 */

/** Semantic indicator glyphs rendered in the widget, inline results, and notifications. */
export const GLYPHS = {
  /** Turn count, as `↻5≤30`. */
  turns: "↻",
  /** Session compaction count, annotating the token field. */
  compactions: "⇊",
  /** Completed outcome, also used dim/warning for a wrapped-up agent. */
  success: "✓",
  /** Error or aborted outcome. */
  failure: "✗",
  /** Stopped outcome. */
  stopped: "■",
  /** Continuation line beneath a result or activity line. */
  subLine: "⎿",
  /** Inline tool-call heading marker. */
  toolCall: "▸",
  /** Live streaming activity in the session transcript. */
  streaming: "◍",
  /** Queued-agents marker in the widget. */
  queued: "◦",
  /** Widget heading while agents are active. */
  agentsActive: "●",
  /** Widget heading while no agents are active. */
  agentsIdle: "○",
} as const;

/** Braille spinner frames for the animated running indicator. */
export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
