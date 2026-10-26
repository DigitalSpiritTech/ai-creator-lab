import { Archive, FolderKanban, Images, Library, Settings } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";

const rail = [
  { label: "Projects", icon: FolderKanban },
  { label: "Assets", icon: Images },
  { label: "Library", icon: Library },
  { label: "Archive", icon: Archive },
  { label: "Settings", icon: Settings },
];

export default function Home() {
  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <aside className="flex w-56 flex-col gap-1 border-r p-4">
        <div className="mb-4 text-sm font-semibold tracking-tight">AI Creator Lab</div>
        {rail.map(item => (
          <div key={item.label} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground">
            <item.icon className="size-4" aria-hidden />
            {item.label}
          </div>
        ))}
        <div className="mt-auto">
          <ThemeToggle />
        </div>
      </aside>
      <main className="flex-1 p-8">
        <h1 className="text-2xl font-semibold tracking-tight">Workspace</h1>
        <p className="mt-2 max-w-prose text-sm text-muted-foreground">
          The scaffold is in place. Projects, Library, the UGC Creator chat, and the generation catalog arrive in the next checkpoints.
        </p>
      </main>
    </div>
  );
}
