import { ADMIN_GUIDED_SETUP_CONSOLE_JS as COOKED_GUIDED_SETUP_CONSOLE_JS } from "./admin-guided-setup-console-script.js";

/**
 * The guided augmentation is composed as a server-side template literal so it can embed the
 * compiled exact-money helpers. JavaScript template literals cook `\n` escapes; those escapes
 * belong to string literals in the browser program, not to the outer server-side template.
 * Restore only newline characters that occur while inside ordinary quoted JavaScript strings.
 */
export function restoreQuotedNewlineEscapes(source: string): string {
  let result = "";
  let quote: '"' | "'" | undefined;
  let escaped = false;

  for (const character of source) {
    if (!quote) {
      result += character;
      if (character === '"' || character === "'") {
        quote = character;
        escaped = false;
      }
      continue;
    }

    if (character === "\n") {
      result += "\\n";
      escaped = false;
      continue;
    }

    result += character;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === quote) {
      quote = undefined;
    }
  }

  return result;
}

export const ADMIN_GUIDED_SETUP_CONSOLE_JS = restoreQuotedNewlineEscapes(
  COOKED_GUIDED_SETUP_CONSOLE_JS,
);
