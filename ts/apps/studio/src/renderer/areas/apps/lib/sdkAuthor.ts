// The Studio's author name, remembered per browser. Not taken from the login:
// lab accounts such as `admin` are shared, so the account says nothing about
// who wrote an app.

const AUTHOR_KEY = "nhos.sdk.author.v1";

/** Placeholder authors the Studio used to fill in on its own. */
export const AUTO_FILLED_AUTHORS = new Set(["author", "admin", "user"]);

export function loadStudioAuthor(): string {
  try {
    return window.localStorage.getItem(AUTHOR_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

export function saveStudioAuthor(author: string): boolean {
  try {
    window.localStorage.setItem(AUTHOR_KEY, author);
    return true;
  } catch {
    return false;
  }
}
