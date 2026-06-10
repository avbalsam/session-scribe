import { useState, useEffect } from "react";
import { apiFetch } from "../api";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "./ui/card";
import { Badge } from "./ui/badge";
import {
  Plus,
  Pencil,
  Trash2,
  ChevronLeft,
} from "lucide-react";

interface Template {
  id: string;
  userId: string | null;
  name: string;
  promptText: string;
  isOwner: boolean;
  isSystem?: boolean;
  createdAt: string | null;
}

export function TemplateManager() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);

  // Form state
  const [editing, setEditing] = useState<string | null>(null); // template id or "new"
  const [formName, setFormName] = useState("");
  const [formPrompt, setFormPrompt] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchTemplates();
  }, []);

  const fetchTemplates = async () => {
    setLoading(true);
    try {
      const res = await apiFetch("/api/templates");
      setTemplates(await res.json());
    } catch {
    } finally {
      setLoading(false);
    }
  };

  const startCreate = () => {
    setEditing("new");
    setFormName("");
    setFormPrompt("");
  };

  const startEdit = (t: Template) => {
    setEditing(t.id);
    setFormName(t.name);
    setFormPrompt(t.promptText);
  };

  const cancelEdit = () => {
    setEditing(null);
  };

  const handleSave = async () => {
    if (!formName.trim() || !formPrompt.trim()) return;
    setSaving(true);

    try {
      if (editing === "new") {
        await apiFetch("/api/templates", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: formName, promptText: formPrompt }),
        });
      } else {
        await apiFetch(`/api/templates/${editing}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: formName, promptText: formPrompt }),
        });
      }
      setEditing(null);
      fetchTemplates();
    } catch {
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this template? This cannot be undone.")) return;
    await apiFetch(`/api/templates/${id}`, { method: "DELETE" });
    fetchTemplates();
  };

  // Form view
  if (editing) {
    return (
      <div className="max-w-2xl mx-auto p-8">
        <button
          onClick={cancelEdit}
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-4 cursor-pointer bg-transparent border-none p-0"
        >
          <ChevronLeft className="h-4 w-4" />
          Back to templates
        </button>
        <Card>
          <CardHeader>
            <CardTitle>{editing === "new" ? "Create Template" : "Edit Template"}</CardTitle>
            <CardDescription>
              Write a system prompt that will be used to generate session summaries from transcripts.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Template Name</label>
              <Input
                placeholder="e.g. SOAP Note, Progress Note"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">System Prompt</label>
              <Textarea
                placeholder="You are a clinical documentation assistant..."
                value={formPrompt}
                onChange={(e) => setFormPrompt(e.target.value)}
                rows={15}
                className="font-mono text-xs"
              />
            </div>
            <div className="flex gap-2 pt-2">
              <Button onClick={handleSave} disabled={saving || !formName.trim() || !formPrompt.trim()}>
                {saving ? "Saving..." : editing === "new" ? "Create Template" : "Save Changes"}
              </Button>
              <Button variant="ghost" onClick={cancelEdit}>Cancel</Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Separate system and user templates
  const systemTemplates = templates.filter((t) => t.isSystem);
  const userTemplates = templates.filter((t) => !t.isSystem);

  return (
    <div className="max-w-2xl mx-auto p-8 space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold text-foreground">Templates</h2>
        <Button size="sm" onClick={startCreate}>
          <Plus className="h-4 w-4" />
          New Template
        </Button>
      </div>

      {loading && <p className="text-sm text-muted-foreground">Loading...</p>}

      {/* System templates */}
      {systemTemplates.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Built-in Templates</h3>
          {systemTemplates.map((t) => (
            <Card key={t.id}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <p className="text-sm font-medium text-foreground">{t.name}</p>
                      <Badge variant="default">Built-in</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground line-clamp-2">
                      {t.promptText.slice(0, 150)}...
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* User templates */}
      <div className="space-y-3">
        <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">My Templates</h3>
        {!loading && userTemplates.length === 0 && (
          <Card>
            <CardContent className="p-8 text-center">
              <p className="text-muted-foreground text-sm mb-4">
                No custom templates yet. Create one to customize how session summaries are generated.
              </p>
              <Button size="sm" onClick={startCreate}>
                <Plus className="h-4 w-4" />
                Create your first template
              </Button>
            </CardContent>
          </Card>
        )}
        {userTemplates.map((t) => (
          <Card key={t.id}>
            <CardContent className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground mb-1">{t.name}</p>
                  <p className="text-xs text-muted-foreground line-clamp-2">
                    {t.promptText.slice(0, 150)}...
                  </p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => startEdit(t)}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-destructive hover:text-destructive"
                    onClick={() => handleDelete(t.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
