import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { findingDetailFor, findingsListFor, rememberFor, siblingDetail, siblingList } from "../context.ts";
import { ROLES } from "../roles.ts";
import { getTask, updateTask } from "../tasks.ts";

/**
 * Tool lintas-role: memori project, koordinasi antar bot, dan jendela ke tugas
 * lain di project yang sama. Usulan operan tidak pernah jalan sendiri — selalu
 * menunggu klik pemilik produk.
 */
export function createTeamServer(taskId: string) {
  return createSdkMcpServer({
    name: "team",
    version: "0.1.0",
    instructions:
      "Memori project dan koordinasi antar bot. `remember` untuk fakta yang berlaku lintas tugas di project ini, " +
      "`suggest_handoff` untuk mengusulkan tugas ini dilanjutkan bot lain, `project_tasks`/`project_task` untuk melihat pekerjaan tugas lain di project yang sama, " +
      "`findings_list`/`finding_detail` untuk register temuan project (sumber kebenaran status temuan).",
    tools: [
      tool(
        "remember",
        "Simpan satu fakta ke memori project yang dibaca semua bot di tugas berikutnya (URL, kredensial uji, keputusan, pantangan). Jangan dipakai untuk detail yang hanya relevan di tugas ini.",
        { note: z.string().describe("satu kalimat, spesifik dan bisa ditindaklanjuti") },
        async (args) => {
          const { project } = rememberFor(taskId, args.note);
          return {
            content: [
              {
                type: "text",
                text: project
                  ? `Dicatat ke kotak masuk memori project ${project} (ikut terbaca tugas berikutnya; kurator merapikannya ke memori project): ${args.note}`
                  : `Dicatat: ${args.note} (tugas ini belum punya project)`,
              },
            ],
          };
        },
      ),
      tool(
        "suggest_handoff",
        "Usulkan tugas ini dilanjutkan oleh bot lain (mis. QA menemukan bug dan mengusulkan Engineer). Usulan hanya muncul sebagai tombol untuk pemilik produk; Anda tetap harus menutup pekerjaan dengan ringkasan serah terima.",
        {
          role: z.enum(["qa", "engineer", "devops"]).describe("bot yang diusulkan melanjutkan"),
          note: z.string().describe("apa yang perlu dikerjakan bot itu, ringkas"),
        },
        async (args) => {
          if (!getTask(taskId)) {
            return { content: [{ type: "text", text: "ERROR: tugas tidak ditemukan" }], isError: true };
          }
          updateTask(taskId, { suggestedNext: { role: args.role, note: args.note, at: new Date().toISOString() } });
          return {
            content: [
              {
                type: "text",
                text: `Usulan operan ke ${ROLES[args.role].title} dicatat. Pemilik produk yang memutuskan; lanjutkan menutup pekerjaan Anda.`,
              },
            ],
          };
        },
      ),
      tool(
        "project_tasks",
        "Daftar tugas lain di project yang sama, dengan status dan ringkasan serah terima. Pakai ini kalau butuh tahu apa yang sudah dikerjakan tugas sebelah.",
        {},
        async () => {
          const answer = siblingList(taskId);
          return { content: [{ type: "text", text: answer.text }], ...(answer.isError ? { isError: true } : {}) };
        },
      ),
      tool(
        "project_task",
        "Detail satu tugas lain di project yang sama: instruksi aslinya, seluruh ringkasan serah terima, path laporan, dan daftar lampirannya (semuanya boleh Anda baca dengan tool Read).",
        { task_id: z.string().describe("id tugas, mis. T-015") },
        async (args) => {
          const answer = siblingDetail(taskId, args.task_id);
          return { content: [{ type: "text", text: answer.text }], ...(answer.isError ? { isError: true } : {}) };
        },
      ),
      tool(
        "findings_list",
        "Daftar temuan di register project (id F-nnn, severity, status, tugas yang melaporkannya). Pakai sebelum melaporkan temuan supaya tidak menggandakan atau melaporkan ulang yang sudah diperbaiki.",
        {
          status: z
            .enum(["open", "needs_retest", "fixed", "wontfix", "invalid", "all"])
            .optional()
            .describe("saring per status; kosong = yang masih terbuka (open + needs_retest)"),
        },
        async (args) => {
          const answer = findingsListFor(taskId, args.status);
          return { content: [{ type: "text", text: answer.text }], ...(answer.isError ? { isError: true } : {}) };
        },
      ),
      tool(
        "finding_detail",
        "Detail satu temuan register: ringkasan, semua kemunculannya di laporan tugas (beserta path laporannya), dan bukti penutupannya.",
        { id: z.string().describe("id temuan, mis. F-012") },
        async (args) => {
          const answer = findingDetailFor(taskId, args.id);
          return { content: [{ type: "text", text: answer.text }], ...(answer.isError ? { isError: true } : {}) };
        },
      ),
    ],
  });
}
