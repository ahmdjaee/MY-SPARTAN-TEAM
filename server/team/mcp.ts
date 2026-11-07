import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { findingDetailFor, findingsListFor, recordRetestFor, rememberFor, reportFixedFor, siblingDetail, siblingList } from "../context.ts";
import { ROLES } from "../roles.ts";
import { getTask, updateTask } from "../tasks.ts";
import type { RoleId } from "../types.ts";

/** Tool status temuan menurut peran: yang memperbaiki tidak bisa memverifikasi perbaikannya sendiri. */
export function findingStatusTools(taskId: string, role: RoleId) {
  // UI/UX hanya melaporkan temuan: tidak memperbaiki, dan uji ulangnya milik QA.
  if (role === "uiux") return [];
  if (role === "qa") {
    return [
      tool(
        "finding_retest",
        "Catat hasil uji ulang satu temuan register. Lolos menutupnya sebagai terverifikasi; gagal mengembalikannya ke daftar temuan terbuka.",
        {
          id: z.string().describe("id temuan, mis. F-012"),
          passed: z.boolean().describe("true bila masalahnya sudah tidak muncul"),
          note: z.string().describe("apa yang diuji dan hasilnya"),
          evidence: z.string().describe("path screenshot di ./assets/ atau bukti lain yang bisa ditelusuri"),
        },
        async (args) => {
          const answer = recordRetestFor(taskId, args.id, args.passed, args.note, args.evidence);
          return { content: [{ type: "text" as const, text: answer.text }], ...(answer.isError ? { isError: true } : {}) };
        },
      ),
    ];
  }
  return [
    tool(
      "finding_report_fixed",
      "Laporkan bahwa Anda sudah memperbaiki satu temuan register. Temuan pindah ke Resolved dengan status menunggu uji ulang QA.",
      {
        id: z.string().describe("id temuan, mis. F-012"),
        note: z.string().describe("apa yang diperbaiki: file dan alasannya"),
        commit: z.string().optional().describe("hash commit; kosongkan kalau belum di-commit"),
      },
      async (args) => {
        const answer = reportFixedFor(taskId, args.id, args.note, args.commit);
        return { content: [{ type: "text" as const, text: answer.text }], ...(answer.isError ? { isError: true } : {}) };
      },
    ),
  ];
}

/**
 * Tool lintas-role: memori project, koordinasi antar bot, dan jendela ke tugas
 * lain di project yang sama. Usulan operan tidak pernah jalan sendiri — selalu
 * menunggu klik pemilik produk.
 */
export function createTeamServer(taskId: string, role: RoleId) {
  return createSdkMcpServer({
    name: "team",
    version: "0.1.0",
    instructions:
      "Memori project dan koordinasi antar bot. `remember` untuk fakta yang berlaku lintas tugas di project ini, " +
      "`suggest_handoff` untuk mengusulkan tugas ini dilanjutkan bot lain, `project_tasks`/`project_task` untuk melihat pekerjaan tugas lain di project yang sama, " +
      "`findings_list`/`finding_detail` untuk register temuan project (sumber kebenaran status temuan), " +
      "`finding_report_fixed` (Engineer/DevOps) dan `finding_retest` (QA) untuk mengubah status temuan; UI/UX melaporkan temuan lewat report.md.",
    tools: [
      ...findingStatusTools(taskId, role),
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
          role: z.enum(["qa", "engineer", "devops", "uiux"]).describe("bot yang diusulkan melanjutkan"),
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
