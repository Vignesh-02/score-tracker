// A titled box on the match page
export function Panel({ title, action, children }) {
  return (
    <section className="overflow-hidden rounded-lg border border-line bg-panel">
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
        <h2 className="text-sm font-bold tracking-[0.15em] text-muted uppercase">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  )
}

export const Empty = ({ children }) => <p className="px-4 py-6 text-center text-muted">{children}</p>
