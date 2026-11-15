
import axios from "axios";
import axiosClient from "../api/axiosClient";

export type QuizDifficulty = "easy" | "medium" | "hard" | "mixed";

export interface GeneratedQuestion {
  question: string;
  options: string[];
  correct_index: number;
  explanation: string;
  source_material_id: string;
  source_name: string;
  source_pages: string;
}

export interface GenerateQuizResponse {
  questions: GeneratedQuestion[];
  warnings: string[];
}

export interface QuizReportResult {
  student_name: string;
  student_email?: string;
  score: number;
  total: number;
  time_taken_seconds?: number | null;
  submitted_at?: string;
}

export interface QuizReportRequest {
  quiz_title: string;
  class_name: string;
  results: QuizReportResult[];
  question_stats?: {
    question: string;
    correct_count: number;
    total_attempts: number;
  }[];
}

async function getErrorMessage(error: unknown, fallback: string) {
  if (!axios.isAxiosError(error)) {
    return error instanceof Error ? error.message : fallback;
  }

  let data: unknown = error.response?.data;
  if (data instanceof Blob) {
    const text = await data.text();
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
  }

  if (typeof data === "object" && data !== null) {
    const responseError = data as { error?: unknown; detail?: unknown };
    if (typeof responseError.detail === "string") return responseError.detail;
    if (typeof responseError.error === "string") return responseError.error;
  }

  return error.message || fallback;
}

export const quizService = {
  async generateQuiz(
    files: File[],
    numQuestions: number,
    difficulty: QuizDifficulty
  ): Promise<GenerateQuizResponse> {
    if (!files.length) {
      throw new Error("Please select at least one file.");
    }

    const formData = new FormData();

    files.forEach((file) => {
      formData.append("files", file);
      formData.append("material_ids", crypto.randomUUID());
    });

    formData.append("num_questions", String(numQuestions));
    formData.append("difficulty", difficulty);

    try {
      const response = await axiosClient.post<GenerateQuizResponse>(
        "/quizzes/generate",
        formData
      );
      return response.data;
    } catch (error) {
      throw new Error(await getErrorMessage(error, "Quiz generation failed."));
    }
  },

  async exportReport(report: QuizReportRequest): Promise<Blob> {
    try {
      const response = await axiosClient.post<Blob>(
        "/quizzes/export-report",
        report,
        { responseType: "blob" }
      );
      return response.data;
    } catch (error) {
      throw new Error(
        await getErrorMessage(error, "Quiz report export failed.")
      );
    }
  },
};
