import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";
import { Icon, type IconName } from "./icons";

export function IconButton({ label, icon, size = 18, className = "", title, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; icon: IconName; size?: number }) {
  return <button {...props} type={props.type ?? "button"} className={`icon-button ${className}`} aria-label={label} title={title ?? label}><Icon name={icon} size={size} /></button>;
}

export function Button({ children, variant = "secondary", icon, className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "quiet" | "danger"; icon?: IconName }) {
  return <button {...props} type={props.type ?? "button"} className={`button button-${variant} ${className}`}>{icon && <Icon name={icon} size={16} />}<span>{children}</span></button>;
}

export function SegmentedControl<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Array<{ value: T; label: string }>; onChange: (value: T) => void }) {
  return <div className="segmented-control" role="group" aria-label={label}>{options.map((option) => <button key={option.value} type="button" className={option.value === value ? "selected" : ""} aria-pressed={option.value === value} onClick={() => onChange(option.value)}>{option.label}</button>)}</div>;
}

export function FieldRow({ label, hint, children, className = "" }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return <div className={`field-row ${className}`}><div className="field-label"><span>{label}</span>{hint && <small>{hint}</small>}</div><div className="field-control">{children}</div></div>;
}

export function NumberField({ label, value, onChange, suffix, min, max, step = 1, disabled = false }: { label: string; value: number; onChange: (value: number) => void; suffix?: string; min?: number; max?: number; step?: number; disabled?: boolean }) {
  return <FieldRow label={label}><div className="number-field"><input aria-label={label} type="number" value={value} min={min} max={max} step={step} disabled={disabled} onChange={(event) => onChange(Number(event.target.value))} />{suffix && <span>{suffix}</span>}</div></FieldRow>;
}

export function SelectField({ label, children, ...props }: SelectHTMLAttributes<HTMLSelectElement> & { label: string }) {
  return <FieldRow label={label}><select {...props} aria-label={label}>{children}</select></FieldRow>;
}

export function TextField({ label, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return <FieldRow label={label}><input {...props} aria-label={label} /></FieldRow>;
}

export function SectionHeading({ children, action, id }: { children: ReactNode; action?: ReactNode; id?: string }) {
  return <div className="section-heading"><h2 id={id}>{children}</h2>{action}</div>;
}

export function StatusBadge({ tone = "neutral", icon, children }: { tone?: "ready" | "warning" | "neutral" | "accent" | "danger"; icon?: IconName; children: ReactNode }) {
  return <span className={`status-badge status-${tone}`}>{icon && <Icon name={icon} size={15} />}<span>{children}</span></span>;
}

export function Notice({ tone = "warning", title, children, action }: { tone?: "warning" | "info" | "success"; title: string; children: ReactNode; action?: ReactNode }) {
  const icon = tone === "success" ? "checkCircle" : tone === "info" ? "info" : "warning";
  return <div className={`notice notice-${tone}`} role={tone === "warning" ? "alert" : "status"}><Icon name={icon} size={19} /><div><strong>{title}</strong><p>{children}</p>{action}</div></div>;
}

export function Disclosure({ title, open, onToggle, children, action }: { title: string; open: boolean; onToggle: () => void; children: ReactNode; action?: ReactNode }) {
  return <section className="disclosure"><div className="disclosure-header"><button type="button" className="disclosure-trigger" aria-expanded={open} onClick={onToggle}><Icon name={open ? "chevronUp" : "chevronDown"} size={16} /><span>{title}</span></button>{action}</div>{open && <div className="disclosure-body">{children}</div>}</section>;
}

export function EmptyAction({ icon, title, description, action }: { icon: IconName; title: string; description: string; action: ReactNode }) {
  return <div className="empty-action"><Icon name={icon} size={28} /><h2>{title}</h2><p>{description}</p>{action}</div>;
}
