import { useState, useRef, useEffect } from "react";
import { Command } from "cmdk";
import { cn } from "../../lib/utils";
import { ChevronDown } from "lucide-react";

interface Template {
  id: string;
  name: string;
  isSystem?: boolean;
}

interface Props {
  templates: Template[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

export function TemplateSelect({ templates, value, onChange, placeholder = "Select a template..." }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const selected = templates.find((t) => t.id === value);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={cn(
          "flex h-10 w-full items-center justify-between rounded-md border border-input bg-card px-3 py-2 text-sm cursor-pointer",
          !selected && "text-muted-foreground"
        )}
      >
        <span className="truncate">
          {selected ? (selected.isSystem ? `${selected.name} (Built-in)` : selected.name) : placeholder}
        </span>
        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-full rounded-md border border-border bg-card shadow-lg overflow-hidden">
          <Command className="bg-transparent">
            <Command.Input
              placeholder="Search templates..."
              className="w-full px-3 py-2 text-sm bg-transparent border-b border-border outline-none placeholder:text-muted-foreground"
              autoFocus
            />
            <Command.List className="max-h-48 overflow-y-auto p-1">
              <Command.Empty className="text-sm text-muted-foreground text-center py-3">
                No templates found
              </Command.Empty>
              {templates.map((t) => (
                <Command.Item
                  key={t.id}
                  value={t.name}
                  onSelect={() => {
                    onChange(t.id);
                    setOpen(false);
                  }}
                  className={cn(
                    "px-3 py-2 text-sm rounded-sm cursor-pointer",
                    t.id === value ? "bg-accent text-foreground" : "text-foreground",
                    "data-[selected=true]:bg-accent/50"
                  )}
                >
                  {t.isSystem ? `${t.name} (Built-in)` : t.name}
                </Command.Item>
              ))}
            </Command.List>
          </Command>
        </div>
      )}
    </div>
  );
}
