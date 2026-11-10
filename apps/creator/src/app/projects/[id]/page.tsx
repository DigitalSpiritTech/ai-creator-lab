import { ProjectView } from "@/components/project/project-view";

/** A project; `?panel=<panel id>` opens the workspace on that panel (the Projects page's Quick Ad button). */
export default async function ProjectPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ panel?: string | string[] }> }) {
  const { id } = await params;
  const { panel } = await searchParams;
  return <ProjectView projectId={id} initialPanel={typeof panel === "string" ? panel : null} />;
}
