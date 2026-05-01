/**
 * Public onboarding page — REQ-17.
 *
 * Static, public, NO auth, NO DB access. Middleware matcher (`/manager/:path*`)
 * does not include `/onboard`, so this route is unauthenticated by design.
 *
 * The 64-char invite token is delivered via the URL fragment (`#token=...`)
 * which is never sent to the server (browsers do not include the fragment
 * in the request line). Parsing happens entirely client-side in the leaf
 * component below — keeping this Server Component shell free of any
 * sensitive data flow.
 *
 * Layout: inherits the root `<RootLayout>` from `app/layout.tsx`.
 */
import { OnboardTokenDisplay } from '@/components/onboarding/onboard-token-display';

export default function OnboardPage() {
  return (
    <main className="mx-auto max-w-2xl p-8">
      <OnboardTokenDisplay />
    </main>
  );
}
