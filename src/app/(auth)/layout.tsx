import Link from 'next/link'

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-[1fr_1.1fr]">
      <div className="hidden flex-col justify-between bg-ink-900 p-10 lg:flex">
        <Link href="/" className="flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-md bg-white text-xs font-bold text-ink-900">AI</span>
          <span className="text-sm font-semibold tracking-tight text-white">AIBA</span>
        </Link>
        <div>
          <h2 className="text-2xl font-semibold tracking-tight text-white">Autonomous Internet Business Agent</h2>
          <p className="mt-3 max-w-md text-sm leading-relaxed text-ink-300">
            Research, scoring, project execution, budget guardrails and revenue tracking for one operator — with a mandatory
            approval gate in front of every public, paid or irreversible action.
          </p>
          <ul className="mt-6 space-y-2 text-xs text-ink-300">
            <li>• 9 specialist agents with a full run ledger</li>
            <li>• Hard daily, monthly, per-project and per-agent budgets</li>
            <li>• Verified revenue separated from estimates and demo data</li>
          </ul>
        </div>
        <p className="text-[11px] text-ink-400">
          AIBA does not guarantee income. Scores are research estimates; results depend on your own execution.
        </p>
      </div>
      <div className="flex items-center justify-center bg-ink-50 px-4 py-12">
        <div className="w-full max-w-sm">{children}</div>
      </div>
    </div>
  )
}
