import { useState, useEffect } from "react";
import { apiFetch } from "../api";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "./ui/card";
import { Badge } from "./ui/badge";
import { cn } from "../lib/utils";
import {
  Plus,
  Pencil,
  Trash2,
  Globe,
  Lock,
  Download,
  X,
  Search,
  Check,
  ChevronLeft,
} from "lucide-react";

interface Template {
  id: string;
  userId: string;
  name: string;
  promptText: string;
  isPublic: boolean;
  isOwner: boolean;
  createdAt: string | null;
}

interface PublicTemplate {
  id: string;
  userId: string;
  name: string;
  promptText: string;
  createdAt: string | null;
  imported: boolean;
}

type Tab = "mine" | "public";

export function TemplateManager() {
  const [tab, setTab] = useState<Tab>("mine");
  const [templates, setTemplates] = useState<Template[]>([]);
  const [publicTemplates, setPublicTemplates] = useState<PublicTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  // Form state
  const [editing, setEditing] = useState<string | null>(null); // template id or "new"
  const [formName, setFormName] = useState("");
  const [formPrompt, setFormPrompt] = useState("");
  const [formPublic, setFormPublic] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (tab === "mine") {
      fetchTemplates();
    } else {
      fetchPublicTemplates();
    }
  }, [tab]);

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

  const fetchPublicTemplates = async () => {
    setLoading(true);
    try {
      const q = search.trim() ? `?search=${encodeURIComponent(search.trim())}` : "";
      const res = await apiFetch(`/api/templates/public${q}`);
      setPublicTemplates(await res.json());
    } catch {
    } finally {
      setLoading(false);
    }
  };

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    fetchPublicTemplates();
  };

  const startCreate = () => {
    setEditing("new");
    setFormName("");
    setFormPrompt("");
    setFormPublic(false);
  };

  const startEdit = (t: Template) => {
    setEditing(t.id);
    setFormName(t.name);
    setFormPrompt(t.promptText);
    setFormPublic(t.isPublic);
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
          body: JSON.stringify({ name: formName, promptText: formPrompt, isPublic: formPublic }),
        });
      } else {
        await apiFetch(`/api/templates/${editing}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: formName, promptText: formPrompt, isPublic: formPublic }),
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

  const handleTogglePublic = async (t: Template) => {
    await apiFetch(`/api/templates/${t.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isPublic: !t.isPublic }),
    });
    fetchTemplates();
  };

  const handleRemoveImport = async (id: string) => {
    await apiFetch(`/api/templates/${id}/import`, { method: "DELETE" });
    fetchTemplates();
  };

  const handleImport = async (id: string) => {
    await apiFetch(`/api/templates/${id}/import`, { method: "POST" });
    fetchPublicTemplates();
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
                placeholder="e.g. DIR/Floortime Session Note"
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
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={formPublic}
                onChange={(e) => setFormPublic(e.target.checked)}
                className="rounded border-input"
              />
              <Globe className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-sm">Make this template public</span>
            </label>
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

  return (
    <div className="max-w-2xl mx-auto p-8 space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold text-foreground">Templates</h2>
        {tab === "mine" && (
          <Button size="sm" onClick={startCreate}>
            <Plus className="h-4 w-4" />
            New Template
          </Button>
        )}
      </div>

      {/* Tab switcher */}
      <div className="flex gap-1 p-1 bg-muted rounded-lg w-fit">
        <button
          className={cn(
            "px-4 py-1.5 text-sm font-medium rounded-md transition-all cursor-pointer border-none",
            tab === "mine" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground bg-transparent"
          )}
          onClick={() => setTab("mine")}
        >
          My Templates
        </button>
        <button
          className={cn(
            "px-4 py-1.5 text-sm font-medium rounded-md transition-all cursor-pointer border-none",
            tab === "public" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground bg-transparent"
          )}
          onClick={() => setTab("public")}
        >
          Public Templates
        </button>
      </div>

      {/* My Templates */}
      {tab === "mine" && (
        <div className="space-y-3">
          {loading && <p className="text-sm text-muted-foreground">Loading...</p>}
          {!loading && templates.length === 0 && (
            <Card>
              <CardContent className="p-8 text-center">
                <p className="text-muted-foreground text-sm mb-4">
                  No templates yet. Create one to customize how session summaries are generated.
                </p>
                <Button size="sm" onClick={startCreate}>
                  <Plus className="h-4 w-4" />
                  Create your first template
                </Button>
              </CardContent>
            </Card>
          )}
          {templates.map((t) => (
            <Card key={t.id}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <p className="text-sm font-medium text-foreground">{t.name}</p>
                      {t.isPublic ? (
                        <Badge variant="secondary" className="gap-1">
                          <Globe className="h-3 w-3" />
                          Public
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="gap-1">
                          <Lock className="h-3 w-3" />
                          Private
                        </Badge>
                      )}
                      {!t.isOwner && (
                        <Badge variant="secondary">Imported</Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground line-clamp-2">
                      {t.promptText.slice(0, 150)}...
                    </p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {t.isOwner ? (
                      <>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => handleTogglePublic(t)}
                          title={t.isPublic ? "Make private" : "Make public"}
                        >
                          {t.isPublic ? <Lock className="h-3.5 w-3.5" /> : <Globe className="h-3.5 w-3.5" />}
                        </Button>
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
                      </>
                    ) : (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => handleRemoveImport(t.id)}
                        title="Remove from library"
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Public Templates */}
      {tab === "public" && (
        <div className="space-y-3">
          <form onSubmit={handleSearchSubmit} className="flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search public templates..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9"
              />
            </div>
            <Button type="submit" variant="secondary">Search</Button>
          </form>

          {loading && <p className="text-sm text-muted-foreground">Loading...</p>}
          {!loading && publicTemplates.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-8">
              No public templates found.
            </p>
          )}
          {publicTemplates.map((t) => (
            <Card key={t.id}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-foreground mb-1">{t.name}</p>
                    <p className="text-xs text-muted-foreground line-clamp-2">
                      {t.promptText.slice(0, 150)}...
                    </p>
                  </div>
                  <div className="shrink-0">
                    {t.imported ? (
                      <Badge variant="secondary" className="gap-1">
                        <Check className="h-3 w-3" />
                        Imported
                      </Badge>
                    ) : (
                      <Button size="sm" variant="outline" onClick={() => handleImport(t.id)}>
                        <Download className="h-3.5 w-3.5" />
                        Import
                      </Button>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
