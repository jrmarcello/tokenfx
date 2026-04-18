export default async function SessionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <section>
      <h1 className="text-2xl font-semibold">Session {id}</h1>
      <p className="mt-2 text-neutral-400">
        Drill-down UI coming in the next batch.
      </p>
    </section>
  );
}
