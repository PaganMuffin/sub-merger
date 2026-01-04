import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

interface ProgressUpdate {
    index: number;
    percentage: number;
    filename: string;
}

interface ProcessError {
    index: number;
    error: string;
    filename: string;
}

function App() {
    // Wyodrębnianie tytułu z nazwy pliku (usunięcie części w nawiasach kwadratowych i rozdzielczości)
    function extractTitle(filename: string): string {
        // Usuń rozszerzenie
        let name = filename.replace(/\.[^/.]+$/, "");
        // Usuń części w nawiasach kwadratowych
        name = name.replace(/\[([^\]]+)\]/g, "").trim();
        // Usuń informacje o rozdzielczości i codecach
        name = name.replace(/\d{3,4}p.*$/i, "").trim();
        name = name.replace(/\(.*?\)/g, "").trim();
        // Usuń numer odcinka (- 01, - 01v2, itp.)
        name = name.replace(/-\s*\d{2,3}(v\d+)?\s*$/, "").trim();
        // Usuń wielokrotne spacje
        name = name.replace(/\s+/g, " ").trim();
        return name;
    }

    // Wyodrębnianie prefixu (tekst w pierwszych nawiasach kwadratowych)
    function extractPrefix(filename: string): string {
        const match = filename.match(/\[([^\]]+)\]/);
        return match ? match[1] : "";
    }

    // Wyodrębnianie numeru odcinka z nazwy pliku
    function extractEpisodeNumber(filename: string): number | null {
        // 1. [Nekomoe ...] ... [01]...
        const bracket = filename.match(/\[(\d{2,3})\]/);
        if (bracket) return parseInt(bracket[1], 10);

        // 2. ... 01 (BDRip ...)
        const beforeParen = filename.match(/\b(\d{2,3})\s*\(/);
        if (beforeParen) return parseInt(beforeParen[1], 10);

        // 3. S01E01
        const sxe = filename.match(/S\d{2,3}E(\d{2,3})/i);
        if (sxe) return parseInt(sxe[1], 10);

        // 4. - 01v2 (ignoruj v2, v3 itp.)
        const dashWithVersion = filename.match(/-\s*(\d{2,3})v\d+\b/i);
        if (dashWithVersion) return parseInt(dashWithVersion[1], 10);

        // 5. - 01 (np. Oshi no Ko - 01 ...)
        const dash = filename.match(/-\s*(\d{2,3})\b/);
        if (dash) return parseInt(dash[1], 10);

        return null;
    }

    // Sortowanie listy plików po numerze odcinka
    function sortByEpisode(files: string[]): string[] {
        return [...files].sort((a, b) => {
            const epA = extractEpisodeNumber(a);
            const epB = extractEpisodeNumber(b);
            if (epA === null && epB === null) return a.localeCompare(b);
            if (epA === null) return 1;
            if (epB === null) return -1;
            return epA - epB;
        });
    }

    const sortVideosByEpisode = () => setVideos((prev) => sortByEpisode(prev));
    const sortSubtitlesByEpisode = () =>
        setSubtitles((prev) => sortByEpisode(prev));
    // Helper to move item in array
    function moveItem<T>(arr: T[], from: number, to: number): T[] {
        if (to < 0 || to >= arr.length) return arr;
        const copy = [...arr];
        const [item] = copy.splice(from, 1);
        copy.splice(to, 0, item);
        return copy;
    }

    const moveVideo = (from: number, to: number) =>
        setVideos((prev) => moveItem(prev, from, to));
    const moveSubtitle = (from: number, to: number) =>
        setSubtitles((prev) => moveItem(prev, from, to));
    const moveFont = (from: number, to: number) =>
        setFonts((prev) => moveItem(prev, from, to));

    const [mode, setMode] = useState<"ffmpeg" | "json">("ffmpeg");
    const [videos, setVideos] = useState<string[]>([]);
    const [subtitles, setSubtitles] = useState<string[]>([]);
    const [fonts, setFonts] = useState<string[]>([]);
    const [fontsFolder, setFontsFolder] = useState<string>("");
    const [title, setTitle] = useState<string>("");
    const [prefix, setPrefix] = useState<string>("");
    const [resolution, setResolution] = useState<"480p" | "720p" | "1080p">(
        "1080p"
    );
    const [isProcessing, setIsProcessing] = useState(false);
    const [progress, setProgress] = useState<Map<number, number>>(new Map());
    const [errors, setErrors] = useState<Map<number, string>>(new Map());
    const [completed, setCompleted] = useState<Set<number>>(new Set());
    const [outputDir, setOutputDir] = useState<string | null>(null);

    const selectFiles = async (type: "video" | "subtitle" | "font") => {
        const filters =
            type === "video"
                ? [
                      {
                          name: "Video",
                          extensions: ["mp4", "mkv", "avi", "mov", "webm"],
                      },
                  ]
                : type === "subtitle"
                ? [
                      {
                          name: "Subtitles",
                          extensions: ["srt", "ass", "ssa", "sub"],
                      },
                  ]
                : [
                      {
                          name: "Fonts",
                          extensions: ["ttf", "otf", "woff", "woff2"],
                      },
                  ];

        const selected = await open({
            multiple: true,
            filters,
        });

        if (selected) {
            const files = Array.isArray(selected) ? selected : [selected];
            if (type === "video") {
                setVideos((prev) => {
                    const newVideos = [...prev, ...files];
                    // Auto-extract title and prefix from first video
                    if (
                        prev.length === 0 &&
                        files.length > 0 &&
                        mode === "json"
                    ) {
                        const firstFile = files[0].split(/[\\/]/).pop() || "";
                        setTitle(extractTitle(firstFile));
                        setPrefix(extractPrefix(firstFile));
                    }
                    return newVideos;
                });
            } else if (type === "subtitle") {
                setSubtitles((prev) => [...prev, ...files]);
            } else if (type === "font") {
                setFonts((prev) => [...prev, ...files]);
            }
        }
    };

    const selectFontsFolder = async () => {
        const directory = await open({
            directory: true,
            multiple: false,
        });
        if (directory) {
            setFontsFolder(directory as string);
        }
    };

    const removeFile = (type: "video" | "subtitle" | "font", index: number) => {
        if (type === "video") {
            setVideos((prev) => prev.filter((_, i) => i !== index));
        } else if (type === "subtitle") {
            setSubtitles((prev) => prev.filter((_, i) => i !== index));
        } else if (type === "font") {
            setFonts((prev) => prev.filter((_, i) => i !== index));
        }
    };

    const selectOutputDirectory = async () => {
        const directory = await open({
            directory: true,
            multiple: false,
        });
        if (directory) {
            setOutputDir(directory as string);
        }
        return directory;
    };

    const startProcessing = async () => {
        if (videos.length === 0 || subtitles.length === 0) {
            alert("Dodaj przynajmniej jedno video i napisy");
            return;
        }

        if (videos.length !== subtitles.length) {
            alert("Liczba plików video musi być równa liczbie napisów");
            return;
        }

        if (mode === "json") {
            // Generate and save JSON
            await generateJson();
            return;
        }

        let outDir = outputDir;
        if (!outDir) {
            const selected = await selectOutputDirectory();
            if (!selected) return;
            outDir = selected as string;
        }

        console.log("Starting processing...");
        console.log("Videos:", videos);
        console.log("Subtitles:", subtitles);
        console.log("Fonts:", fonts);
        console.log("Output dir:", outDir);

        setIsProcessing(true);
        setProgress(new Map());
        setErrors(new Map());
        setCompleted(new Set());

        // Setup event listeners
        const unlistenProgress = await listen<ProgressUpdate>(
            "ffmpeg-progress",
            (event) => {
                setProgress((prev) => {
                    const newMap = new Map(prev);
                    newMap.set(event.payload.index, event.payload.percentage);
                    return newMap;
                });
            }
        );

        const unlistenError = await listen<ProcessError>(
            "ffmpeg-error",
            (event) => {
                setErrors((prev) => {
                    const newMap = new Map(prev);
                    newMap.set(event.payload.index, event.payload.error);
                    return newMap;
                });
            }
        );

        const unlistenComplete = await listen<{ index: number }>(
            "ffmpeg-complete",
            (event) => {
                setCompleted((prev) => new Set(prev).add(event.payload.index));
            }
        );

        try {
            await invoke("process_queue", {
                videos,
                subtitles,
                fonts,
                outputDir: outDir,
            });
        } catch (error) {
            console.error("Processing error:", error);
            alert(`Błąd: ${error}`);
        } finally {
            setIsProcessing(false);
            unlistenProgress();
            unlistenError();
            unlistenComplete();
        }
    };

    const cancelProcessing = async () => {
        try {
            await invoke("cancel_processing");
        } catch (error) {
            console.error("Cancel error:", error);
        }
    };

    const getFilename = (path: string) => {
        return path.split(/[\\/]/).pop() || path;
    };

    const generateJson = async () => {
        const jsonData = {
            fonts: mode === "json" ? fontsFolder || "fonts" : undefined,
            title: title || extractTitle(getFilename(videos[0])),
            prefix: prefix || extractPrefix(getFilename(videos[0])),
            resolution,
            items: videos.map((video, index) => ({
                video: getFilename(video),
                subtitles: getFilename(subtitles[index]),
            })),
        };

        const jsonString = JSON.stringify(jsonData, null, 4);

        // Select folder to save
        const saveDir = await open({
            directory: true,
            multiple: false,
        });

        if (saveDir && typeof saveDir === "string") {
            const savePath = `${saveDir}/table.json`;
            try {
                await invoke("save_json", {
                    path: savePath,
                    content: jsonString,
                });
                alert(`Plik JSON zapisany: ${savePath}`);
            } catch (error) {
                alert(`Błąd zapisu: ${error}`);
            }
        }
    };

    return (
        <div className="app">
            <div className="header">
                <h1>Sub Merger - Łączenie Video z Napisami</h1>
                <div className="mode-switch">
                    <button
                        className={`mode-btn ${
                            mode === "ffmpeg" ? "active" : ""
                        }`}
                        onClick={() => setMode("ffmpeg")}
                        disabled={isProcessing}
                    >
                        Tryb FFmpeg
                    </button>
                    <button
                        className={`mode-btn ${
                            mode === "json" ? "active" : ""
                        }`}
                        onClick={() => setMode("json")}
                        disabled={isProcessing}
                    >
                        Tryb JSON
                    </button>
                </div>
            </div>

            {mode === "json" && (
                <div className="json-config">
                    <div className="json-field">
                        <label>Tytuł:</label>
                        <input
                            type="text"
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                            placeholder="Auto-wypełniane z pierwszego video"
                            disabled={isProcessing}
                        />
                    </div>
                    <div className="json-field">
                        <label>Prefix:</label>
                        <input
                            type="text"
                            value={prefix}
                            onChange={(e) => setPrefix(e.target.value)}
                            placeholder="Auto-wypełniane z pierwszego video"
                            disabled={isProcessing}
                        />
                    </div>
                    <div className="json-field">
                        <label>Rozdzielczość:</label>
                        <select
                            value={resolution}
                            onChange={(e) =>
                                setResolution(
                                    e.target.value as "480p" | "720p" | "1080p"
                                )
                            }
                            disabled={isProcessing}
                        >
                            <option value="480p">480p</option>
                            <option value="720p">720p</option>
                            <option value="1080p">1080p</option>
                        </select>
                    </div>
                    <div className="json-field">
                        <label>Folder czcionek:</label>
                        <div
                            style={{
                                display: "flex",
                                gap: "8px",
                                alignItems: "center",
                            }}
                        >
                            <input
                                type="text"
                                value={fontsFolder}
                                onChange={(e) => setFontsFolder(e.target.value)}
                                placeholder="fonts"
                                disabled={isProcessing}
                                style={{ flex: 1 }}
                            />
                            <button
                                className="btn btn-secondary"
                                onClick={selectFontsFolder}
                                disabled={isProcessing}
                            >
                                Wybierz folder
                            </button>
                        </div>
                    </div>
                </div>
            )}

            <div className="main-grid">
                <div className="top-row">
                    <div className="drop-zone-container">
                        <div className="zone-header">
                            <h2>Video ({videos.length})</h2>
                            {videos.length > 1 && (
                                <button
                                    className="btn-sort"
                                    onClick={sortVideosByEpisode}
                                    disabled={isProcessing}
                                    title="Sortuj wg numeru odcinka"
                                >
                                    Sortuj
                                </button>
                            )}
                            {videos.length > 0 && (
                                <button
                                    className="btn-add"
                                    onClick={() => selectFiles("video")}
                                    disabled={isProcessing}
                                >
                                    + Dodaj więcej
                                </button>
                            )}
                        </div>
                        {videos.length === 0 ? (
                            <div
                                className="drop-zone"
                                onClick={() => selectFiles("video")}
                            >
                                <div className="drop-icon">🎥</div>
                                <div className="drop-text">
                                    Kliknij, aby wybrać pliki video
                                </div>
                            </div>
                        ) : (
                            <div className="file-list">
                                {videos.map((video, index) => (
                                    <div key={index} className="file-item">
                                        <span className="file-item-index">
                                            {extractEpisodeNumber(video) ??
                                                "--"}
                                        </span>
                                        <span
                                            className="file-item-name"
                                            title={video}
                                        >
                                            {getFilename(video)}
                                        </span>
                                        <div className="file-item-actions">
                                            <button
                                                className="file-item-move"
                                                title="Góra"
                                                onClick={() =>
                                                    moveVideo(index, index - 1)
                                                }
                                                disabled={
                                                    isProcessing || index === 0
                                                }
                                            >
                                                ↑
                                            </button>
                                            <button
                                                className="file-item-move"
                                                title="Dół"
                                                onClick={() =>
                                                    moveVideo(index, index + 1)
                                                }
                                                disabled={
                                                    isProcessing ||
                                                    index === videos.length - 1
                                                }
                                            >
                                                ↓
                                            </button>
                                            <button
                                                className="file-item-remove"
                                                onClick={() =>
                                                    removeFile("video", index)
                                                }
                                                disabled={isProcessing}
                                            >
                                                ✕
                                            </button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                    <div className="drop-zone-container">
                        <div className="zone-header">
                            <h2>Napisy ({subtitles.length})</h2>
                            {subtitles.length > 1 && (
                                <button
                                    className="btn-sort"
                                    onClick={sortSubtitlesByEpisode}
                                    disabled={isProcessing}
                                    title="Sortuj wg numeru odcinka"
                                >
                                    Sortuj
                                </button>
                            )}
                            {subtitles.length > 0 && (
                                <button
                                    className="btn-add"
                                    onClick={() => selectFiles("subtitle")}
                                    disabled={isProcessing}
                                >
                                    + Dodaj więcej
                                </button>
                            )}
                        </div>
                        {subtitles.length === 0 ? (
                            <div
                                className="drop-zone"
                                onClick={() => selectFiles("subtitle")}
                            >
                                <div className="drop-icon">📝</div>
                                <div className="drop-text">
                                    Kliknij, aby wybrać pliki napisów
                                </div>
                            </div>
                        ) : (
                            <div className="file-list">
                                {subtitles.map((subtitle, index) => (
                                    <div key={index} className="file-item">
                                        <span className="file-item-index">
                                            {extractEpisodeNumber(subtitle) ??
                                                "--"}
                                        </span>
                                        <span
                                            className="file-item-name"
                                            title={subtitle}
                                        >
                                            {getFilename(subtitle)}
                                        </span>
                                        <div className="file-item-actions">
                                            <button
                                                className="file-item-move"
                                                title="Góra"
                                                onClick={() =>
                                                    moveSubtitle(
                                                        index,
                                                        index - 1
                                                    )
                                                }
                                                disabled={
                                                    isProcessing || index === 0
                                                }
                                            >
                                                ↑
                                            </button>
                                            <button
                                                className="file-item-move"
                                                title="Dół"
                                                onClick={() =>
                                                    moveSubtitle(
                                                        index,
                                                        index + 1
                                                    )
                                                }
                                                disabled={
                                                    isProcessing ||
                                                    index ===
                                                        subtitles.length - 1
                                                }
                                            >
                                                ↓
                                            </button>
                                            <button
                                                className="file-item-remove"
                                                onClick={() =>
                                                    removeFile(
                                                        "subtitle",
                                                        index
                                                    )
                                                }
                                                disabled={isProcessing}
                                            >
                                                ✕
                                            </button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
                {mode === "ffmpeg" && (
                    <div className="bottom-row">
                        <div className="drop-zone-container">
                            <div className="zone-header">
                                <h2>Czcionki ({fonts.length})</h2>
                                {fonts.length > 0 && (
                                    <button
                                        className="btn-add"
                                        onClick={() => selectFiles("font")}
                                        disabled={isProcessing}
                                    >
                                        + Dodaj więcej
                                    </button>
                                )}
                            </div>
                            {fonts.length === 0 ? (
                                <div
                                    className="drop-zone"
                                    onClick={() => selectFiles("font")}
                                >
                                    <div className="drop-icon">🔤</div>
                                    <div className="drop-text">
                                        Kliknij, aby wybrać czcionki
                                    </div>
                                </div>
                            ) : (
                                <div className="file-list">
                                    {fonts.map((font, index) => (
                                        <div key={index} className="file-item">
                                            <span
                                                className="file-item-name"
                                                title={font}
                                            >
                                                {getFilename(font)}
                                            </span>
                                            <div className="file-item-actions">
                                                <button
                                                    className="file-item-move"
                                                    title="Góra"
                                                    onClick={() =>
                                                        moveFont(
                                                            index,
                                                            index - 1
                                                        )
                                                    }
                                                    disabled={
                                                        isProcessing ||
                                                        index === 0
                                                    }
                                                >
                                                    ↑
                                                </button>
                                                <button
                                                    className="file-item-move"
                                                    title="Dół"
                                                    onClick={() =>
                                                        moveFont(
                                                            index,
                                                            index + 1
                                                        )
                                                    }
                                                    disabled={
                                                        isProcessing ||
                                                        index ===
                                                            fonts.length - 1
                                                    }
                                                >
                                                    ↓
                                                </button>
                                                <button
                                                    className="file-item-remove"
                                                    onClick={() =>
                                                        removeFile(
                                                            "font",
                                                            index
                                                        )
                                                    }
                                                    disabled={isProcessing}
                                                >
                                                    ✕
                                                </button>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                )}
            </div>

            <div className="controls">
                {mode === "ffmpeg" && (
                    <>
                        <button
                            className="btn btn-secondary"
                            onClick={selectOutputDirectory}
                            disabled={isProcessing}
                        >
                            Wybierz folder docelowy
                        </button>
                        <span className="output-dir-label">
                            {outputDir
                                ? `Wybrany folder: ${outputDir}`
                                : "(brak wybranego folderu)"}
                        </span>
                    </>
                )}
                <button
                    className="btn btn-primary"
                    onClick={startProcessing}
                    disabled={
                        isProcessing ||
                        videos.length === 0 ||
                        subtitles.length === 0
                    }
                >
                    {isProcessing
                        ? "Przetwarzanie..."
                        : mode === "json"
                        ? "Generuj JSON"
                        : "Rozpocznij łączenie"}
                </button>
                {isProcessing && (
                    <button
                        className="btn btn-danger"
                        onClick={cancelProcessing}
                    >
                        Anuluj
                    </button>
                )}
            </div>

            {isProcessing && (
                <div className="progress-container">
                    {videos.map((video, index) => (
                        <div key={index} className="progress-item">
                            <div className="progress-header">
                                <span className="progress-filename">
                                    {index}: {getFilename(video)}
                                </span>
                                <span className="progress-percentage">
                                    {completed.has(index)
                                        ? "✓ Ukończono"
                                        : `${Math.round(
                                              progress.get(index) || 0
                                          )}%`}
                                </span>
                            </div>
                            <div className="progress-bar">
                                <div
                                    className="progress-bar-fill"
                                    style={{
                                        width: completed.has(index)
                                            ? "100%"
                                            : `${progress.get(index) || 0}%`,
                                    }}
                                />
                            </div>
                            {errors.has(index) && (
                                <div className="progress-error">
                                    {errors.get(index)}
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

export default App;
