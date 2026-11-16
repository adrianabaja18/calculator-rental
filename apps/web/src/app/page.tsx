import { redirect } from 'next/navigation';

/** "/" has no content of its own: signed-in officers land on the dashboard
 *  (src/proxy.ts sends everyone else to /login first). */
export default function HomePage() {
  redirect('/dashboard');
}
