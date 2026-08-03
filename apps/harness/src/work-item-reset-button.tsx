export function WorkItemResetButton({
  pending,
  disabled,
  onReset,
}: {
  readonly pending: boolean
  readonly disabled: boolean
  readonly onReset: () => void
}) {
  const label = pending ? "Resetting job" : "Reset job"

  return (
    <button
      type="button"
      className="group relative isolate block h-[2.125rem] w-9 shrink-0 cursor-pointer border-0 bg-transparent p-0 text-ink disabled:cursor-wait disabled:opacity-55 data-[pending=true]:opacity-100"
      disabled={disabled}
      onClick={onReset}
      aria-label={label}
      aria-busy={pending}
      title={pending ? "Resetting..." : "Reset"}
      data-pending={pending}
      data-work-item-reset-control
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute right-1 bottom-[-0.15rem] left-1 -z-10 h-2 rounded-[50%] bg-black/30 blur-[3px] transition-transform duration-100 group-hover:scale-x-105"
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute top-[-0.1rem] left-[0.86rem] z-[4] grid h-[0.65rem] w-2 place-items-center border border-[#1d1d1d] bg-[#f6f0d7] font-mono text-[0.22rem] font-extrabold text-[#3f3a31] opacity-0 shadow-[0_1px_2px_rgb(0_0_0/0.35)] rotate-[8deg] group-data-[pending=true]:animate-[work-item-reset-ticket_1.35s_ease-in-out_infinite]"
      >
        #
      </span>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute right-[0.22rem] bottom-0 left-[0.22rem] z-[2] h-[1.48rem] overflow-hidden rounded-t-[0.18rem] rounded-b-[0.38rem] border border-[#35170f] bg-[radial-gradient(circle_at_68%_17%,rgb(81_38_23/0.48)_0_1px,transparent_1.6px),radial-gradient(circle_at_22%_73%,rgb(239_173_117/0.24)_0_1px,transparent_1.8px),repeating-linear-gradient(0deg,transparent_0_4px,rgb(43_18_11/0.2)_4px_5px),linear-gradient(92deg,#3d1a11_0%,#854126_11%,#d48a58_31%,#9f5432_52%,#e19a68_68%,#73341f_86%,#32140d_100%)] shadow-[inset_2px_0_2px_rgb(255_204_154/0.2),inset_-3px_0_3px_rgb(32_11_6/0.38),inset_0_-4px_5px_rgb(41_15_7/0.25),0_1px_0_#1c0c08] [clip-path:polygon(5%_0,95%_0,84%_100%,16%_100%)] transition-[filter] duration-150 group-hover:saturate-[1.16] group-hover:brightness-105 group-data-[pending=true]:animate-[work-item-reset-bin_1.35s_ease-in-out_infinite]"
      >
        <span className="absolute top-[0.3rem] right-[0.05rem] left-[0.05rem] h-[0.14rem] border-y border-[#4d2114] bg-[linear-gradient(#dc8c54,#6f321f_45%,#b9623a_70%,#4a2015)] shadow-[0_1px_2px_rgb(39_14_7/0.35)]" />
        <span className="absolute right-[0.05rem] bottom-[0.24rem] left-[0.05rem] h-[0.14rem] border-y border-[#4d2114] bg-[linear-gradient(#dc8c54,#6f321f_45%,#b9623a_70%,#4a2015)] shadow-[0_1px_2px_rgb(39_14_7/0.35)]" />
        <span className="absolute top-[0.57rem] left-1/2 grid h-2 w-2 -translate-x-1/2 place-items-center rounded-full border border-[#432015] bg-[radial-gradient(circle_at_38%_30%,#e5aa75,#8a4329_55%,#3d1a10)] font-display text-[0.28rem] font-black text-[#3b190f] shadow-[inset_0_1px_rgb(255_220_174/0.35),0_1px_1px_rgb(35_11_5/0.5)]">
          R
        </span>
      </span>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute top-[0.4rem] left-[0.04rem] z-[5] h-[0.52rem] w-[2.17rem] origin-[90%_58%] rounded-[50%] border border-[#32140d] bg-[radial-gradient(ellipse_at_45%_20%,#efb07b_0%,#b96b43_34%,#71351f_67%,#30120b_100%)] shadow-[inset_0_1px_1px_rgb(255_223_184/0.38),inset_0_-2px_1px_rgb(45_14_7/0.52),0_1px_1px_rgb(37_12_6/0.42)] transition-transform duration-150 group-hover:-translate-y-px group-hover:-rotate-3 group-data-[pending=true]:animate-[work-item-reset-lid_1.35s_ease-in-out_infinite]"
      >
        <span className="absolute top-[-0.06rem] right-[0.24rem] bottom-[-0.06rem] left-[0.24rem] rounded-[50%] border border-[rgb(72_30_18/0.76)]" />
      </span>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute top-[0.05rem] left-[0.68rem] z-[6] h-[0.4rem] w-[0.88rem] origin-[86%_90%] rounded-t-[0.35rem] border-[0.1rem] border-b-0 border-[#49251b] shadow-[inset_0.05rem_0_#b6704c,0_1px_1px_rgb(0_0_0/0.5)] group-data-[pending=true]:animate-[work-item-reset-lid_1.35s_ease-in-out_infinite]"
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute top-[0.66rem] right-[0.02rem] z-[7] h-[0.16rem] w-[0.28rem] rounded-[0.12rem] border border-[#2f130c] bg-[linear-gradient(#c67648,#552719)]"
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute top-0 right-[0.28rem] z-[8] h-[0.3rem] w-[0.3rem] rounded-full bg-[#857c72] opacity-0 blur-[1px] group-data-[pending=true]:animate-[work-item-reset-steam_1.35s_ease-in-out_0.7s_infinite]"
      />
    </button>
  )
}
