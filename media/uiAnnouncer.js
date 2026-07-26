// Screen-reader live-region announcements for Django Shell webviews.

/** Creates polite and assertive live-region announcement helpers. */
export function createAnnouncer(root = document) {
  const polite = root.getElementById("politeAnnouncements");
  const assertive = root.getElementById("assertiveAnnouncements");

  /** Writes a message after clearing the target so repeated status is announced. */
  function announce(target, message) {
    if (!target || !message) {
      return;
    }
    target.textContent = "";
    requestAnimationFrame(() => {
      target.textContent = String(message);
    });
  }

  return {
    /** Announces normal progress and completion without interrupting speech. */
    announceStatus(message) {
      announce(polite, message);
    },
    /** Announces an actionable failure immediately. */
    announceError(message) {
      announce(assertive, message);
    }
  };
}

