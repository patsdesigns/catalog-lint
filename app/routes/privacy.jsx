// The privacy policy the App Store listing links to (https://catalog-lint.onrender.com/privacy).
// Public, like the login page: no authentication, no App Bridge, no Polaris, only plain HTML. Keep it
// in step with what the app stores: a new kind of data (the weekly email address when that returns,
// for example) belongs here in the same change, with a new date.

export const meta = () => [{ title: "TidyUp privacy policy" }];

const PAGE = { maxWidth: "680px", margin: "48px auto", padding: "0 16px", fontFamily: "Inter, system-ui, sans-serif", lineHeight: 1.6 };

export default function Privacy() {
  return (
    <main style={PAGE}>
      <h1>TidyUp privacy policy</h1>
      <p>Last updated September 24, 2026</p>
      <p>
        TidyUp: Product Data Cleanup (“TidyUp”) is a Shopify app made by Pat’s Designs. It checks a store’s product data
        for problems and fixes them where the merchant chooses. This policy explains what TidyUp collects, why, how long it
        is kept, and how to reach us.
      </p>

      <h2>What TidyUp reads through Shopify</h2>
      <p>
        With the permissions the merchant approves at install, TidyUp reads the store’s products, variants, inventory,
        product metafields, sales channels, languages, time zone and currency. It uses them to run its checks, and it
        changes product data only when the merchant applies a fix. Shopify also gives TidyUp an access token for the store,
        which TidyUp keeps so it can work on the merchant’s behalf.
      </p>

      <h2>What TidyUp stores</h2>
      <ul>
        <li>Recent scan results: the problems found, with the product titles and values involved. Older results are deleted automatically.</li>
        <li>A record of each change TidyUp makes, with the value it replaced, so the change can be undone.</li>
        <li>The merchant’s settings: which checks run, dictionary words, ignored findings and tracked metafields.</li>
        <li>Plan details, including whether the store took an Early Bird seat.</li>
        <li>
          Support messages sent from the app: the name, email address and message the merchant enters. They are also
          emailed to hello@patsdesigns.com so we can reply.
        </li>
      </ul>
      <p>
        Our hosting provider also keeps technical request logs, which include the store’s Shopify address, for a short time
        for security and troubleshooting.
      </p>

      <h2>What TidyUp does not collect</h2>
      <p>
        TidyUp has no access to a store’s customers or orders and collects no information about shoppers. It adds nothing
        to the storefront and uses no cookies, tracking or analytics.
      </p>

      <h2>How the information is used</h2>
      <p>
        Only to provide TidyUp: running checks, showing and applying fixes, undoing changes, applying the merchant’s plan
        and answering support messages. We don’t sell it, share it for advertising or use it for anything else.
      </p>

      <h2>Where it is stored and who processes it</h2>
      <ul>
        <li>Render hosts the app and its database in the United States.</li>
        <li>Resend delivers support messages by email.</li>
        <li>Shopify provides the store data, installation and billing.</li>
      </ul>

      <h2>How long it is kept</h2>
      <p>
        For as long as TidyUp is installed. When a store uninstalls TidyUp, the app stops working on its behalf at once.
        Forty-eight hours later Shopify asks TidyUp to erase the store’s data, and TidyUp deletes everything it stored for
        that store. The only thing kept is an anonymous count of the Early Bird seats used. Support emails already in our
        inbox are deleted on request.
      </p>

      <h2>Contact</h2>
      <p>
        For questions, or to ask what we hold about your store or to have it deleted, email{" "}
        <a href="mailto:hello@patsdesigns.com">hello@patsdesigns.com</a>.
      </p>

      <h2>Changes</h2>
      <p>If this policy changes, the new version is posted on this page with a new date.</p>
    </main>
  );
}
