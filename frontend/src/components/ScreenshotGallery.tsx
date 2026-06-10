import { useState, useEffect, useCallback } from "react";
import { API_BASE_URL } from "../config";
import { apiFetch } from "../api";
import { Card, CardContent } from "./ui/card";
import { Button } from "./ui/button";
import {
  Image,
  ChevronLeft,
  ChevronRight,
  X,
} from "lucide-react";

interface Screenshot {
  id: number;
  name: string;
  url: string;
  contentType: string;
  createdAt: string | null;
}

interface ScreenshotResponse {
  screenshots: Screenshot[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

interface Props {
  sessionId: string;
  isLive: boolean;
}

const PAGE_SIZE = 20;

export function ScreenshotGallery({ sessionId, isLive }: Props) {
  const [data, setData] = useState<ScreenshotResponse | null>(null);
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const fetchPage = useCallback(
    async (p: number) => {
      try {
        const res = await apiFetch(
          `/api/sessions/${sessionId}/screenshots?page=${p}&limit=${PAGE_SIZE}`
        );
        if (!res.ok) return;
        const json = await res.json();
        if (json.screenshots) {
          setData(json as ScreenshotResponse);
        }
      } catch {}
    },
    [sessionId]
  );

  useEffect(() => {
    fetchPage(page);
  }, [page, fetchPage]);

  // Poll for new screenshots during live sessions when on the last page
  useEffect(() => {
    if (!isLive) return;
    if (data && page < data.totalPages) return;

    const interval = setInterval(() => {
      fetchPage(page);
    }, 5000);
    return () => clearInterval(interval);
  }, [isLive, page, data?.totalPages, fetchPage]);

  // Auto-advance to new last page when total grows
  useEffect(() => {
    if (!isLive || !data) return;
    if (data.totalPages > 0 && page < data.totalPages) {
      setPage(data.totalPages);
    }
  }, [isLive, data?.totalPages]);

  const selectedScreenshot =
    selectedId !== null
      ? data?.screenshots.find((s) => s.id === selectedId)
      : null;

  if (!data) return null;

  return (
    <>
      <Card>
        <CardContent className="p-5 space-y-4">
          {data.screenshots.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <Image className="h-10 w-10 mb-3 opacity-40" />
              <p className="text-sm font-medium">No screenshots yet</p>
              <p className="text-xs mt-1">
                {isLive
                  ? "Screenshots will appear here as the bot captures them"
                  : "No screenshots were captured for this session"}
              </p>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                {data.screenshots.map((s) => (
                  <button
                    key={s.id}
                    className="group text-left cursor-pointer bg-transparent border-none p-0"
                    onClick={() => setSelectedId(s.id)}
                  >
                    <img
                      src={`${API_BASE_URL}${s.url}`}
                      alt={s.name}
                      loading="lazy"
                      className="rounded-lg border border-border w-full object-cover transition-all group-hover:border-primary/50 group-hover:shadow-md"
                    />
                    <p className="text-xs text-muted-foreground mt-1.5 text-center truncate">
                      {s.name}
                    </p>
                  </button>
                ))}
              </div>

              {data.totalPages > 1 && (
                <div className="flex items-center justify-center gap-3 pt-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => p - 1)}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <span className="text-sm text-muted-foreground">
                    Page {data.page} of {data.totalPages}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page >= data.totalPages}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Full-size overlay */}
      {selectedScreenshot && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
          onClick={() => setSelectedId(null)}
        >
          <div
            className="relative max-w-[90vw] max-h-[90vh]"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="absolute -top-3 -right-3 z-10 bg-card border border-border rounded-full p-1.5 shadow-lg hover:bg-accent transition-colors cursor-pointer"
              onClick={() => setSelectedId(null)}
            >
              <X className="h-4 w-4" />
            </button>
            <img
              src={`${API_BASE_URL}${selectedScreenshot.url}`}
              alt={selectedScreenshot.name}
              className="rounded-lg max-w-full max-h-[85vh] object-contain"
            />
            <p className="text-sm text-muted-foreground text-center mt-2">
              {selectedScreenshot.name}
            </p>
          </div>
        </div>
      )}
    </>
  );
}
