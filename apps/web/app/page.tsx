import { connection } from "next/server";
import { TodayView } from "@/components/today/today-view";
import { DEFAULT_API } from "@/lib/api";

/**
 * "/" is today. The API base is read per request (PLANNER_API, else NEXT_PUBLIC_PLANNER_API, else
 * http://127.0.0.1:4317) so one build can point at the real API or the fixture server.
 * `?now=<iso>` is forwarded to the API; only the fixture API honours it.
 */
export default async function Page({ searchParams }: PageProps<"/">) {
  await connection();
  const sp = await searchParams;
  const pinnedNow = typeof sp.now === "string" ? sp.now : undefined;
  const apiBase = process.env.PLANNER_API ?? process.env.NEXT_PUBLIC_PLANNER_API ?? DEFAULT_API;
  return <TodayView apiBase={apiBase} pinnedNow={pinnedNow} />;
}
