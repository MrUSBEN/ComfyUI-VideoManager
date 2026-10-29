import { app } from "/scripts/app.js";

app.registerExtension({
  name: "VideoManager.Gallery",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "VideoManager") return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
      const node = this;
      let lastEntries = [];
      let currentEntry = null;

      const mkBtn = (label) => {
        const b = document.createElement("button");
        b.textContent = label;
        b.style.fontSize = "11px";
        b.style.padding = "2px 6px";
        b.style.cursor = "pointer";
        return b;
      };

      const bucketWidget = node.widgets?.find((w) => w.name === "bucket");

      const getBucket = () => (bucketWidget && bucketWidget.value) || "default";

      // Hide the raw text widget from the canvas (it still serializes
      // normally into the prompt) now that we're driving it from the
      // dropdown below.
      const hideWidget = (w) => {
        if (!w || w._vmHidden) return;
        w._vmHidden = true;
        w.origType = w.type;
        w.origComputeSize = w.computeSize;
        w.type = "hidden";
        w.computeSize = () => [0, -4];
      };
      hideWidget(bucketWidget);

      // ---------------- container ----------------
      const container = document.createElement("div");
      container.style.display = "flex";
      container.style.flexDirection = "column";
      container.style.gap = "4px";
      container.style.width = "100%";

      // ---------------- grid view ----------------
      const gridWrap = document.createElement("div");
      gridWrap.style.display = "flex";
      gridWrap.style.flexDirection = "column";
      gridWrap.style.gap = "4px";

      const bucketRow = document.createElement("div");
      bucketRow.style.display = "flex";
      bucketRow.style.gap = "4px";
      bucketRow.style.alignItems = "center";

      const bucketSelect = document.createElement("select");
      bucketSelect.style.flex = "1";
      bucketSelect.style.fontSize = "11px";
      bucketSelect.style.padding = "2px 4px";
      bucketSelect.style.cursor = "pointer";

      const addBucketBtn = mkBtn("+");
      addBucketBtn.title = "Add a new bucket";
      addBucketBtn.style.padding = "2px 8px";
      addBucketBtn.style.fontWeight = "bold";

      const deleteBucketBtn = mkBtn("\u2212");
      deleteBucketBtn.title = "Delete this bucket";
      deleteBucketBtn.style.padding = "2px 8px";
      deleteBucketBtn.style.fontWeight = "bold";
      deleteBucketBtn.style.color = "#ff6b6b";
      deleteBucketBtn.style.background = "rgba(200,0,0,0.15)";
      deleteBucketBtn.style.border = "1px solid rgba(220,0,0,0.4)";
      deleteBucketBtn.style.borderRadius = "3px";

      bucketRow.append(bucketSelect, addBucketBtn, deleteBucketBtn);

      const toolbar = document.createElement("div");
      toolbar.style.display = "flex";
      toolbar.style.gap = "6px";

      const refreshBtn = mkBtn("Refresh");
      const selectAllBtn = mkBtn("Select All");
      const clearBtn = mkBtn("Clear Sel.");
      const exportBtn2 = mkBtn("Export");
      const bulkDeleteBtn = mkBtn("Delete");
      bulkDeleteBtn.style.color = "#ff6b6b";
      bulkDeleteBtn.style.background = "rgba(200,0,0,0.15)";
      bulkDeleteBtn.style.border = "1px solid rgba(220,0,0,0.4)";
      bulkDeleteBtn.style.borderRadius = "3px";
      const countLabel = document.createElement("span");
      countLabel.style.fontSize = "11px";
      countLabel.style.marginLeft = "auto";
      countLabel.style.alignSelf = "center";

      toolbar.append(refreshBtn, selectAllBtn, clearBtn, exportBtn2, bulkDeleteBtn, countLabel);

      const grid = document.createElement("div");
      grid.style.display = "grid";
      grid.style.gridTemplateColumns = "repeat(auto-fill, minmax(72px, 1fr))";
      grid.style.gap = "4px";
      grid.style.maxHeight = "320px";
      grid.style.overflowY = "auto";
      grid.style.padding = "4px";
      grid.style.background = "rgba(0,0,0,0.2)";
      grid.style.borderRadius = "4px";

      gridWrap.append(bucketRow, toolbar, grid);

      const dropHint = document.createElement("div");
      const defaultHintText = "Drag & drop video files here to add them to this bucket";
      dropHint.textContent = defaultHintText;
      dropHint.style.fontSize = "10px";
      dropHint.style.opacity = "0.55";
      dropHint.style.textAlign = "center";
      dropHint.style.padding = "1px 0";

      gridWrap.append(dropHint);

      // ---------------- player view ----------------
      const playerWrap = document.createElement("div");
      playerWrap.style.display = "none";
      playerWrap.style.flexDirection = "column";
      playerWrap.style.gap = "4px";

      const videoEl = document.createElement("video");
      videoEl.controls = true;
      videoEl.muted = true;
      videoEl.volume = 0;
      videoEl.style.width = "100%";
      videoEl.style.maxWidth = "100%";
      videoEl.style.height = "auto";
      videoEl.style.display = "block";
      videoEl.style.borderRadius = "4px";
      videoEl.style.background = "#000";

      const playerToolbar = document.createElement("div");
      playerToolbar.style.display = "flex";
      playerToolbar.style.alignItems = "center";
      playerToolbar.style.gap = "6px";
      playerToolbar.style.flexWrap = "wrap";

      const backBtn = mkBtn("\u2190 Back");
      const selectBtn = mkBtn("\u2606 Select");
      const exportBtn = mkBtn("Export");
      const deleteBtn = mkBtn("Delete");

      const volLabel = document.createElement("span");
      volLabel.textContent = "\ud83d\udd0a";
      volLabel.style.fontSize = "11px";

      const volSlider = document.createElement("input");
      volSlider.type = "range";
      volSlider.min = "0";
      volSlider.max = "1";
      volSlider.step = "0.01";
      volSlider.value = "0";
      volSlider.style.width = "70px";

      playerToolbar.append(backBtn, selectBtn, exportBtn, deleteBtn, volLabel, volSlider);

      const promptText = document.createElement("div");
      promptText.style.fontSize = "11px";
      promptText.style.opacity = "0.8";
      promptText.style.maxHeight = "48px";
      promptText.style.overflowY = "auto";
      promptText.style.whiteSpace = "pre-wrap";

      playerWrap.append(videoEl, playerToolbar, promptText);

      container.append(gridWrap, playerWrap);

      // ---------------- drag & drop upload ----------------
      const VIDEO_EXT_RE = /\.(mp4|webm|mov|mkv|avi|gif|webp|m4v)$/i;
      let dragDepth = 0;

      const setDropHighlight = (on) => {
        container.style.outline = on ? "2px dashed #4caf50" : "";
        container.style.outlineOffset = on ? "-2px" : "";
      };

      container.addEventListener("dragenter", (ev) => {
        ev.preventDefault();
        dragDepth++;
        setDropHighlight(true);
      });
      container.addEventListener("dragover", (ev) => {
        ev.preventDefault();
        if (ev.dataTransfer) ev.dataTransfer.dropEffect = "copy";
      });
      container.addEventListener("dragleave", () => {
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) setDropHighlight(false);
      });
      container.addEventListener("drop", async (ev) => {
        ev.preventDefault();
        dragDepth = 0;
        setDropHighlight(false);

        const files = Array.from(ev.dataTransfer?.files || []).filter(
          (f) => f.type.startsWith("video/") || VIDEO_EXT_RE.test(f.name)
        );
        if (files.length === 0) return;

        const bucket = getBucket();
        dropHint.textContent = `Uploading ${files.length} video${files.length > 1 ? "s" : ""} to "${bucket}"...`;

        const form = new FormData();
        for (const file of files) form.append("files", file, file.name);

        try {
          const res = await fetch(`/video_manager/upload?bucket=${encodeURIComponent(bucket)}`, {
            method: "POST",
            body: form,
          });
          const data = await res.json();
          const added = (data && data.added) || 0;
          dropHint.textContent =
            added > 0
              ? `Added ${added} video${added === 1 ? "" : "s"} to "${bucket}".`
              : "No videos were added.";
        } catch (e) {
          dropHint.textContent = "Upload failed.";
        }

        refresh();
        setTimeout(() => {
          dropHint.textContent = defaultHintText;
        }, 2500);
      });

      // ---------------- behavior ----------------
      const updateSelectBtn = () => {
        if (!currentEntry) return;
        if (currentEntry.selected) {
          selectBtn.textContent = "\u2713 Selected";
          selectBtn.style.background = "#2e7d32";
          selectBtn.style.color = "#fff";
        } else {
          selectBtn.textContent = "\u2606 Select";
          selectBtn.style.background = "";
          selectBtn.style.color = "";
        }
      };

      const showGrid = () => {
        videoEl.pause();
        playerWrap.style.display = "none";
        gridWrap.style.display = "flex";
        refresh();
      };

      const showPlayer = (entry) => {
        currentEntry = entry;
        const bucket = getBucket();
        gridWrap.style.display = "none";
        playerWrap.style.display = "flex";
        videoEl.src = `/video_manager/media/${bucket}/video/${entry.video_file}`;
        videoEl.muted = true;
        videoEl.volume = 0;
        volSlider.value = "0";
        videoEl.currentTime = 0;
        videoEl.play().catch(() => {});
        promptText.textContent = entry.prompt || "(no prompt)";
        updateSelectBtn();
      };

      const populateBucketSelect = async (selectValue) => {
        let buckets = [];
        try {
          const res = await fetch("/video_manager/buckets");
          const data = await res.json();
          buckets = data.buckets || [];
        } catch (e) {
          buckets = [];
        }
        const want = selectValue || getBucket();
        if (!buckets.includes(want)) buckets.push(want);

        bucketSelect.innerHTML = "";
        for (const b of buckets) {
          const opt = document.createElement("option");
          opt.value = b;
          opt.textContent = b;
          bucketSelect.appendChild(opt);
        }
        bucketSelect.value = want;
      };

      const setBucket = (name) => {
        if (bucketWidget) {
          bucketWidget.value = name;
          if (typeof bucketWidget.callback === "function") {
            bucketWidget.callback(name, app.canvas, node);
          }
        }
      };

      bucketSelect.onchange = () => {
        setBucket(bucketSelect.value);
        refresh();
      };

      addBucketBtn.onclick = async () => {
        const name = window.prompt("New bucket name:");
        if (!name) return;
        const trimmed = name.trim();
        if (!trimmed) return;
        const res = await fetch("/video_manager/create_bucket", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bucket: trimmed }),
        });
        const data = await res.json();
        const created = (data && data.bucket) || trimmed;
        await populateBucketSelect(created);
        setBucket(created);
        refresh();
      };

      deleteBucketBtn.onclick = async () => {
        const bucket = getBucket();
        if (!bucket) return;
        const ok = confirm(
          `Delete bucket "${bucket}" and ALL its videos? This cannot be undone.`
        );
        if (!ok) return;
        const res = await fetch("/video_manager/delete_bucket", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bucket }),
        });
        const data = await res.json();
        const remaining = (data && data.buckets) || ["default"];
        const next = remaining.includes("default") ? "default" : remaining[0] || "default";
        await populateBucketSelect(next);
        setBucket(next);
        refresh();
      };

      volSlider.oninput = (e) => {
        const v = parseFloat(e.target.value);
        videoEl.volume = v;
        videoEl.muted = v <= 0;
      };

      backBtn.onclick = showGrid;

      // right-click anywhere on the player goes back to grid
      playerWrap.oncontextmenu = (e) => {
        e.preventDefault();
        e.stopPropagation();
        showGrid();
      };

      selectBtn.onclick = async () => {
        if (!currentEntry) return;
        const bucket = getBucket();
        const res = await fetch("/video_manager/toggle", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bucket, id: currentEntry.id }),
        });
        const data = await res.json();
        currentEntry.selected = data.selected;
        updateSelectBtn();
      };

      exportBtn.onclick = () => {
        if (!currentEntry) return;
        const bucket = getBucket();
        const a = document.createElement("a");
        a.href = `/video_manager/media/${bucket}/video/${currentEntry.video_file}`;
        a.download = currentEntry.video_file;
        document.body.appendChild(a);
        a.click();
        a.remove();
      };

      deleteBtn.onclick = async () => {
        if (!currentEntry) return;
        if (!confirm("Delete this video? This can't be undone.")) return;
        const bucket = getBucket();
        await fetch("/video_manager/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bucket, id: currentEntry.id }),
        });
        showGrid();
      };

      let lastSignature = "";

      const refresh = async () => {
        const bucket = getBucket();
        populateBucketSelect(bucket);
        const res = await fetch(`/video_manager/list?bucket=${encodeURIComponent(bucket)}`);
        const entries = await res.json();

        const signature = entries.map((e) => `${e.id}:${e.selected ? 1 : 0}`).join(",");
        lastEntries = entries;

        // If nothing changed, skip the DOM rebuild so polling doesn't
        // flicker, reset scroll position, or reload thumbnails.
        if (signature === lastSignature && grid.childElementCount > 0) {
          countLabel.textContent = `${entries.filter((e) => e.selected).length}/${entries.length} selected`;
          return;
        }
        lastSignature = signature;

        const prevScrollTop = grid.scrollTop;
        grid.innerHTML = "";
        let selCount = 0;

        for (const e of entries) {
          if (e.selected) selCount++;

          const tile = document.createElement("div");
          tile.style.position = "relative";
          tile.style.border = e.selected ? "2px solid #4caf50" : "2px solid transparent";
          tile.style.borderRadius = "4px";
          tile.style.cursor = "pointer";
          tile.title = e.prompt || "";

          const img = document.createElement("img");
          img.src = `/video_manager/media/${bucket}/frame/${e.frame_file}`;
          img.style.width = "100%";
          img.style.aspectRatio = "1 / 1";
          img.style.objectFit = "cover";
          img.style.display = "block";
          img.style.borderRadius = "3px";
          tile.appendChild(img);

          const selectMark = document.createElement("div");
          selectMark.textContent = e.selected ? "\u2713" : "";
          selectMark.title = e.selected ? "Selected \u2014 click to deselect" : "Click to select";
          Object.assign(selectMark.style, {
            position: "absolute", top: "2px", right: "2px",
            width: "17px", height: "17px", borderRadius: "50%",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: "11px", color: "#fff", cursor: "pointer",
            background: e.selected ? "#4caf50" : "rgba(0,0,0,0.55)",
            border: e.selected ? "none" : "1px solid rgba(255,255,255,0.5)",
          });
          selectMark.onclick = async (ev) => {
            ev.stopPropagation();
            await fetch("/video_manager/toggle", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ bucket, id: e.id }),
            });
            refresh();
          };
          tile.appendChild(selectMark);

          tile.onclick = () => showPlayer(e);

          grid.appendChild(tile);
        }

        countLabel.textContent = `${selCount}/${entries.length} selected`;
        grid.scrollTop = prevScrollTop;
      };

      refreshBtn.onclick = refresh;
      selectAllBtn.onclick = async () => {
        await fetch("/video_manager/select_all", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bucket: getBucket(), value: true }),
        });
        refresh();
      };
      clearBtn.onclick = async () => {
        await fetch("/video_manager/select_all", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bucket: getBucket(), value: false }),
        });
        refresh();
      };

      exportBtn2.onclick = async () => {
        const bucket = getBucket();
        const selectedIds = lastEntries.filter((e) => e.selected).map((e) => e.id);
        if (selectedIds.length === 0) {
          alert("No videos selected. Select the videos you want to export first.");
          return;
        }
        const res = await fetch("/video_manager/export_zip", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bucket, ids: selectedIds }),
        });
        if (!res.ok) {
          alert("Export failed.");
          return;
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${bucket}_export_${Date.now()}.zip`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      };

      bulkDeleteBtn.onclick = async () => {
        const bucket = getBucket();
        const selectedIds = lastEntries.filter((e) => e.selected).map((e) => e.id);
        if (selectedIds.length === 0) {
          alert("No videos selected. Select the videos you want to delete first.");
          return;
        }
        const label = selectedIds.length === 1 ? "this video" : `these ${selectedIds.length} videos`;
        if (!confirm(`Delete ${label}? This can't be undone.`)) return;
        await Promise.all(
          selectedIds.map((id) =>
            fetch("/video_manager/delete", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ bucket, id }),
            })
          )
        );
        refresh();
      };

      node.addDOMWidget("video_manager_gallery", "gallery", container, {
        serialize: false,
        hideOnZoom: false,
      });

      setTimeout(refresh, 300);
      node._vmRefresh = refresh;

      // Poll in the background so new videos show up in the gallery in
      // real time while a generation loop is running, even if this
      // node's onExecuted callback doesn't fire for every iteration
      // (e.g. loop nodes that re-queue execution outside the normal
      // single-run flow). Only rebuilds the DOM when something actually
      // changed, so this is cheap and won't disturb the grid/player.
      node._vmPollTimer = setInterval(() => {
        if (playerWrap.style.display === "none") {
          refresh();
        }
      }, 2000);

      return r;
    };

    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      const r = onExecuted ? onExecuted.apply(this, arguments) : undefined;
      if (this._vmRefresh) this._vmRefresh();
      return r;
    };

    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      if (this._vmPollTimer) {
        clearInterval(this._vmPollTimer);
        this._vmPollTimer = null;
      }
      return onRemoved ? onRemoved.apply(this, arguments) : undefined;
    };
  },
});
