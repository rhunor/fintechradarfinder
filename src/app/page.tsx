/**
 * page.tsx — public landing page.
 *
 * Deliberately almost empty: the real UI is the Telegram bot, and /deals is
 * password protected. This page exists so the deployment has a valid root.
 */
export default function Home() {
  return (
    <main className="mx-auto max-w-xl p-10">
      <h1 className="text-2xl font-semibold">Fintech Deal Radar</h1>
      <p className="mt-2 text-slate-600">
        Watching US and Canadian fintech funding and acquisition news. Alerts are delivered
        over Telegram.
      </p>
      <a className="mt-6 inline-block text-blue-600 underline" href="/deals">
        View detected deals
      </a>
    </main>
  );
}
