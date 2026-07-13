const APPLICATION_ORIGIN = "https://application.invalid";
const RAW_WHITESPACE_OR_CONTROL = /[\s\u0000-\u001f\u007f]/u;
const DECODED_CONTROL = /[\u0000-\u001f\u007f]/u;

/**
 * Return an unchanged, same-origin application destination or the root fallback.
 * Validation checks both the URL text and its decoded form so browser/parser
 * normalization cannot turn an accepted value into an authority or traversal.
 */
export function safeApplicationPath(
  destination: string | null | undefined,
): string {
  if (
    typeof destination !== "string" ||
    destination[0] !== "/" ||
    destination[1] === "/" ||
    RAW_WHITESPACE_OR_CONTROL.test(destination) ||
    destination.includes("\\")
  ) {
    return "/";
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(destination);
  } catch {
    return "/";
  }

  if (
    decoded[0] !== "/" ||
    decoded[1] === "/" ||
    decoded.includes("\\") ||
    DECODED_CONTROL.test(decoded)
  ) {
    return "/";
  }

  const pathEnd = destination.search(/[?#]/u);
  const rawPath = pathEnd === -1 ? destination : destination.slice(0, pathEnd);
  const decodedPath = decodeURIComponent(rawPath);
  if (decodedPath.split("/").some((segment) => segment === "." || segment === "..")) {
    return "/";
  }

  try {
    const parsed = new URL(destination, APPLICATION_ORIGIN);
    const pathIsUnchanged =
      parsed.pathname === rawPath || decodeURI(parsed.pathname) === rawPath;
    if (
      parsed.origin !== APPLICATION_ORIGIN ||
      parsed.username ||
      parsed.password ||
      !pathIsUnchanged
    ) {
      return "/";
    }
  } catch {
    return "/";
  }

  return destination;
}
