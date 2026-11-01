import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { App } from "./App.tsx";
import { MemoryRoute, ProjectRoute, SettingsRoute, TaskRoute, TasksIndex } from "./routes.tsx";
import "./styles.css";
import { applyTheme, readTheme } from "./theme.ts";

// Tema dipasang sebelum render supaya tidak ada kedipan warna.
applyTheme(readTheme());

const container = document.getElementById("root");
if (!container) throw new Error("#root tidak ditemukan");

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        {/* App adalah kerangka (sidebar + Outlet); isi kanannya ditentukan alamat. */}
        <Route element={<App />}>
          <Route index element={<TasksIndex />} />
          <Route path="tasks/:id" element={<TaskRoute />} />
          <Route path="tasks/:id/:tab" element={<TaskRoute />} />
          <Route path="projects/:projectId" element={<ProjectRoute />} />
          <Route path="memory" element={<MemoryRoute />} />
          <Route path="settings" element={<SettingsRoute />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
