/**
 * The left rail: Projects, Assets, Library, Archive, Settings, and the theme toggle.
 * @packageDocumentation
 */
"use client";

import { Archive, FolderKanban, Images, Library, Settings } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "@/components/theme-toggle";

export const RAIL = [
  { label: "Projects", href: "/projects", icon: FolderKanban },
  { label: "Assets", href: "/assets", icon: Images },
  { label: "Library", href: "/library", icon: Library },
  { label: "Archive", href: "/archive", icon: Archive },
  { label: "Settings", href: "/settings", icon: Settings },
] as const;

export function AppRail() {
  const pathname = usePathname();
  return (
    <aside className="sticky top-0 flex h-screen w-48 shrink-0 flex-col gap-1 border-r bg-sidebar p-3 text-sidebar-foreground">
      <Link href="/projects" className="mb-4 px-2 pt-1 text-sm font-semibold tracking-tight">
        AI Creator Lab
      </Link>
      <nav className="flex flex-col gap-0.5" aria-label="Workspace">
        {RAIL.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                active && "bg-sidebar-accent font-medium text-sidebar-accent-foreground",
              )}
            >
              <item.icon className="size-4" aria-hidden />
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="mt-auto">
        <ThemeToggle />
      </div>
    </aside>
  );
}
