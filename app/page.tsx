import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { loadLists } from "@/lib/queries";
import Header from "./components/Header";
import Browser from "./components/Browser";

// The main three-column browser. It reads the database, so it must be dynamic.
export const dynamic = "force-dynamic";

export default async function Home() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const lists = loadLists(session.user.id);

  return (
    <div className="flex h-screen flex-col">
      <Header />
      <Browser lists={lists} />
    </div>
  );
}
