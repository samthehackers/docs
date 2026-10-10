/** First focusable thing on the page: jumps past the header to <main id="content">. Visible only while focused. */
export function SkipLink() {
  return (
    <a href="#content"
      className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-3 focus:z-50 focus:rounded-md focus:bg-background focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:shadow-lg focus:ring-2 focus:ring-primary">
      Skip to content
    </a>
  );
}
