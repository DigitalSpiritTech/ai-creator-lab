import { LibraryDetail } from "@/components/library/library-detail";

export default async function LibraryItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <LibraryDetail itemId={id} />;
}
