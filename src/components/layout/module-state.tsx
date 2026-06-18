import { AlertTriangle, Loader2 } from "lucide-react";

type ModuleStateProps = {
  type: "loading" | "error" | "empty";
  title: string;
  detail?: string;
};

export function ModuleState({ type, title, detail }: ModuleStateProps) {
  const Icon = type === "loading" ? Loader2 : AlertTriangle;

  return (
    <div className="flex min-h-40 items-center gap-3 border border-dashed border-slate-300 bg-white px-4 py-5 text-sm text-slate-600">
      <Icon
        className={`h-5 w-5 text-slate-500 ${type === "loading" ? "animate-spin" : ""}`}
        aria-hidden="true"
      />
      <div>
        <p className="font-medium text-slate-900">{title}</p>
        {detail ? <p className="mt-1">{detail}</p> : null}
      </div>
    </div>
  );
}
