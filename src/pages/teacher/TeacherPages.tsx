import { useState } from "react";
import { BarChart3, Plus, Users, ClipboardCheck, CalendarCheck, Download, Trash2 } from "lucide-react";
import { AIInsightCard } from "../../components/ai/AIComponents";
import { ActivityAreaChart, DistributionChart, PerformanceLineChart, SubjectBarChart } from "../../components/charts/Charts";
import { PageHeader } from "../../components/layout/PageHeader";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { DataTable } from "../../components/ui/DataTable";
import { Input, Label, Select } from "../../components/ui/Input";
import { Modal } from "../../components/ui/Modal";
import { ProgressBar } from "../../components/ui/ProgressBar";
import { StatCard } from "../../components/ui/StatCard";
import { assignments, courses, students, weakTopics } from "../../data/mockData";
import { AIQuizGeneratorPage } from "../student/AIFeaturePages";
import { NotificationsPage, ProfilePage, ResourcesPage, SettingsPage } from "../student/StudentUtilityPages";
import { useNavigate } from "react-router-dom";
import { EmptyState } from "../../components/ui/EmptyState";
import { CourseMaterialsManager } from "../../components/courses/CourseMaterialsManager";
import { quizService, type QuizReportRequest } from "../../services/quizService";

type QuizReportResultForm = {
  student_name: string;
  student_email: string;
  score: string;
  total: string;
  time_taken_seconds: string;
  submitted_at: string;
};

const emptyQuizReportResult = (): QuizReportResultForm => ({
  student_name: "",
  student_email: "",
  score: "",
  total: "",
  time_taken_seconds: "",
  submitted_at: "",
});

export function TeacherDashboard() {
  return (
    <>
      <PageHeader title="Teacher Dashboard" subtitle="Class performance, attendance, quizzes and recent activity." />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard title="Total Students" value="148" detail="Across active courses" icon={Users} />
        <StatCard title="Average Class Score" value="76%" detail="+6% over last month" icon={BarChart3} />
        <StatCard title="Assignment Completion" value="82%" detail="24 pending reviews" icon={ClipboardCheck} />
        <StatCard title="Average Attendance" value="89%" detail="3 students below threshold" icon={CalendarCheck} />
      </div>
      <div className="grid gap-6 lg:grid-cols-2"><Card><h2 className="mb-4 font-semibold">Class performance</h2><PerformanceLineChart /></Card><Card><h2 className="mb-4 font-semibold">Attendance</h2><ActivityAreaChart /></Card><Card><h2 className="mb-4 font-semibold">Quiz performance</h2><SubjectBarChart /></Card><Card><h2 className="mb-4 font-semibold">Recent activity</h2><div className="space-y-3">{assignments.map((item) => <div key={item.id} className="rounded-md bg-slate-50 p-3 text-sm dark:bg-slate-800">{item.title} • {item.status}</div>)}</div></Card></div>
    </>
  );
}

export function TeacherCoursesPage() {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  return (
    <>
      <PageHeader title="Course Management" subtitle="Create courses, add modules and upload resources." actions={<Button onClick={() => setOpen(true)}><Plus size={18} /> Create course</Button>} />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{courses.map((course) => <Card key={course.id}><div className="flex items-start justify-between gap-3"><div><h3 className="font-semibold">{course.title}</h3><p className="text-sm text-slate-500">{course.students} students</p></div><Badge tone={course.status === "Active" ? "success" : "warning"}>{course.status}</Badge></div><ProgressBar className="mt-4" value={course.progress} /><div className="mt-4 flex flex-wrap gap-2"><Button variant="secondary" onClick={() => setMessage(`${course.title} opened for editing.`)}>Edit</Button><Button variant="secondary" onClick={() => setMessage(`New module added to ${course.title}.`)}>Add modules</Button><Button variant="secondary" onClick={() => setMessage(`Upload queue opened for ${course.title}.`)}>Upload notes</Button><Button variant="danger" onClick={() => setMessage(`${course.title} moved to archived draft for demo.`)}>Delete</Button></div></Card>)}</div>
      {message && <p className="rounded-md bg-emerald-50 p-3 text-sm text-emerald-700">{message}</p>}
      <Modal open={open} title="Create Course" onClose={() => setOpen(false)}>
        <div className="grid gap-4"><div><Label>Course title</Label><Input placeholder="Computer Networks" /></div><div><Label>Description</Label><Input placeholder="Course description" /></div><Button onClick={() => { setOpen(false); setMessage("Course created and saved as active draft."); }}>Save course</Button></div>
      </Modal>
    </>
  );
}

export function TeacherStudentsPage() {
  return (
    <>
      <PageHeader title="Students" subtitle="Select a student to inspect attendance, progress and predicted performance." />
      <DataTable data={students} columns={[{ key: "name", header: "Name" }, { key: "email", header: "Email" }, { key: "course", header: "Course" }, { key: "progress", header: "Progress", render: (row) => <div className="min-w-32"><ProgressBar value={row.progress} /></div> }, { key: "status", header: "Status", render: (row) => <Badge tone={row.status === "Active" ? "success" : "warning"}>{row.status}</Badge> }, { key: "id", header: "Actions", render: () => <Button variant="secondary">View analytics</Button> }]} />
      <Card><h2 className="mb-4 font-semibold">Selected Student Analytics</h2><div className="grid gap-6 lg:grid-cols-2"><PerformanceLineChart /><AIInsightCard title="AI predicted performance">Student is likely to score 74%. Weak topics: Graphs, Dynamic Programming. Recommended action: targeted practice set and attendance follow-up.</AIInsightCard></div></Card>
    </>
  );
}

export function TeacherAssignmentsPage() {
  const [message, setMessage] = useState("");
  return (
    <>
      <PageHeader title="Assignments" subtitle="Create assignments and review student submissions." actions={<Button onClick={() => setMessage("Assignment creation form opened for demo.")}><Plus size={18} /> Create assignment</Button>} />
      <DataTable data={assignments} columns={[{ key: "title", header: "Title" }, { key: "subject", header: "Subject" }, { key: "dueDate", header: "Due date" }, { key: "status", header: "Status" }, { key: "id", header: "Actions", render: (row) => <Button variant="secondary" onClick={() => setMessage(`Reviewing ${row.title}.`)}>Review</Button> }]} />
      {message && <p className="rounded-md bg-emerald-50 p-3 text-sm text-emerald-700">{message}</p>}
    </>
  );
}


export function TeacherQuizzesPage() {
  const navigate = useNavigate();

  return (
    <>
      <PageHeader
        title="Quiz Management"
        subtitle="Create, manage and publish quizzes for your students."
        actions={
          <Button onClick={() => navigate("/teacher/ai-generator")}>
            <Plus size={18} />
            Generate with AI
          </Button>
        }
      />

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <Badge tone="ai">AI-powered</Badge>
          <h2 className="mt-3 text-lg font-semibold">
            AI Quiz Generator
          </h2>
          <p className="mt-2 text-sm text-slate-500">
            Upload study materials and generate multiple-choice
            questions automatically.
          </p>
          <Button
            className="mt-4"
            onClick={() => navigate("/teacher/ai-generator")}
          >
            Open AI Generator
          </Button>
        </Card>

        <Card>
          <Badge tone="success">Quiz Management</Badge>
          <h2 className="mt-3 text-lg font-semibold">
            Published Quizzes
          </h2>
          <p className="mt-2 text-sm text-slate-500">
            Manage quizzes that students can access and attempt.
          </p>
        </Card>
      </div>

      <Card>
        <h2 className="mb-4 font-semibold">
          Your Published Quizzes
        </h2>

        <EmptyState
          title="No published quizzes yet"
          description="Once you review and publish a quiz, it will appear here."
        />
      </Card>
    </>
  );
}

export function TeacherUploadPage() {
  return (
    <>
      <PageHeader title="Resources" subtitle="Upload PDF, PPT, DOC and process them with AI." />
      <CourseMaterialsManager />
      <ResourcesPage />
    </>
  );
}

export function TeacherAIReportsPage() {
  const [quizTitle, setQuizTitle] = useState("");
  const [className, setClassName] = useState("");
  const [results, setResults] = useState<QuizReportResultForm[]>([
    emptyQuizReportResult(),
  ]);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");

  async function exportQuizReport(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setExportError("");

    const invalidResult = results.find(
      (result) =>
        !result.student_name.trim() ||
        !Number.isInteger(Number(result.score)) ||
        !Number.isInteger(Number(result.total)) ||
        Number(result.total) < 1 ||
        Number(result.score) < 0 ||
        Number(result.score) > Number(result.total) ||
        (result.time_taken_seconds !== "" &&
          (!Number.isInteger(Number(result.time_taken_seconds)) ||
            Number(result.time_taken_seconds) < 0)),
    );
    if (invalidResult) {
      setExportError(
        "Enter a student name, a valid score and total, and a non-negative time.",
      );
      return;
    }

    const report: QuizReportRequest = {
      quiz_title: quizTitle.trim(),
      class_name: className.trim(),
      results: results.map((result) => ({
        student_name: result.student_name.trim(),
        student_email: result.student_email.trim(),
        score: Number(result.score),
        total: Number(result.total),
        time_taken_seconds:
          result.time_taken_seconds === ""
            ? null
            : Number(result.time_taken_seconds),
        submitted_at: result.submitted_at,
      })),
    };

    setExporting(true);
    try {
      const file = await quizService.exportReport(report);
      const downloadUrl = URL.createObjectURL(file);
      const link = document.createElement("a");
      link.href = downloadUrl;
      link.download = "quiz_report.xlsx";
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 0);
    } catch (error) {
      setExportError(
        error instanceof Error ? error.message : "Quiz report export failed.",
      );
    } finally {
      setExporting(false);
    }
  }

  return (
    <>
      <PageHeader title="AI Reports" subtitle="Class weak topics and students requiring attention." />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card><h2 className="mb-4 font-semibold">Class Weak Topics</h2>{weakTopics.slice(3).map((topic) => <div key={topic.topic} className="mb-4"><div className="mb-1 flex justify-between text-sm"><span>{topic.topic}</span><span>{topic.score}%</span></div><ProgressBar value={topic.score} /></div>)}</Card>
        <Card><h2 className="mb-4 font-semibold">Students At Risk</h2>{students.filter((student) => student.status !== "Active").map((student) => <div key={student.id} className="mb-3 rounded-md bg-slate-50 p-3 dark:bg-slate-800"><p className="font-semibold">{student.name}</p><p className="text-sm text-slate-500">{student.status}</p></div>)}</Card>
      </div>
      <Card>
        <h2 className="font-semibold">Export quiz results</h2>
        <p className="mt-1 text-sm text-slate-500">
          Download an Excel report using the results you provide.
        </p>
        <form className="mt-4 grid gap-4" onSubmit={exportQuizReport}>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="quiz-report-title">Quiz title</Label>
              <Input
                id="quiz-report-title"
                required
                value={quizTitle}
                onChange={(event) => setQuizTitle(event.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="quiz-report-class">Class</Label>
              <Input
                id="quiz-report-class"
                required
                value={className}
                onChange={(event) => setClassName(event.target.value)}
              />
            </div>
          </div>

          {results.map((result, index) => (
            <div
              key={index}
              className="grid gap-3 rounded-md border border-slate-200 p-4 dark:border-slate-700 sm:grid-cols-2 lg:grid-cols-3"
            >
              <div>
                <Label htmlFor={`quiz-student-name-${index}`}>Student name</Label>
                <Input
                  id={`quiz-student-name-${index}`}
                  required
                  value={result.student_name}
                  onChange={(event) =>
                    setResults((current) =>
                      current.map((item, itemIndex) =>
                        itemIndex === index
                          ? { ...item, student_name: event.target.value }
                          : item,
                      ),
                    )
                  }
                />
              </div>
              <div>
                <Label htmlFor={`quiz-student-email-${index}`}>Email</Label>
                <Input
                  id={`quiz-student-email-${index}`}
                  type="email"
                  value={result.student_email}
                  onChange={(event) =>
                    setResults((current) =>
                      current.map((item, itemIndex) =>
                        itemIndex === index
                          ? { ...item, student_email: event.target.value }
                          : item,
                      ),
                    )
                  }
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor={`quiz-student-score-${index}`}>Score</Label>
                  <Input
                    id={`quiz-student-score-${index}`}
                    type="number"
                    min="0"
                    required
                    value={result.score}
                    onChange={(event) =>
                      setResults((current) =>
                        current.map((item, itemIndex) =>
                          itemIndex === index
                            ? { ...item, score: event.target.value }
                            : item,
                        ),
                      )
                    }
                  />
                </div>
                <div>
                  <Label htmlFor={`quiz-student-total-${index}`}>Total</Label>
                  <Input
                    id={`quiz-student-total-${index}`}
                    type="number"
                    min="1"
                    required
                    value={result.total}
                    onChange={(event) =>
                      setResults((current) =>
                        current.map((item, itemIndex) =>
                          itemIndex === index
                            ? { ...item, total: event.target.value }
                            : item,
                        ),
                      )
                    }
                  />
                </div>
              </div>
              <div>
                <Label htmlFor={`quiz-student-time-${index}`}>
                  Time taken (seconds)
                </Label>
                <Input
                  id={`quiz-student-time-${index}`}
                  type="number"
                  min="0"
                  value={result.time_taken_seconds}
                  onChange={(event) =>
                    setResults((current) =>
                      current.map((item, itemIndex) =>
                        itemIndex === index
                          ? { ...item, time_taken_seconds: event.target.value }
                          : item,
                      ),
                    )
                  }
                />
              </div>
              <div>
                <Label htmlFor={`quiz-student-submitted-${index}`}>
                  Submitted at
                </Label>
                <Input
                  id={`quiz-student-submitted-${index}`}
                  type="datetime-local"
                  value={result.submitted_at}
                  onChange={(event) =>
                    setResults((current) =>
                      current.map((item, itemIndex) =>
                        itemIndex === index
                          ? { ...item, submitted_at: event.target.value }
                          : item,
                      ),
                    )
                  }
                />
              </div>
              {results.length > 1 && (
                <div className="flex items-end">
                  <Button
                    type="button"
                    variant="danger"
                    onClick={() =>
                      setResults((current) =>
                        current.filter((_, itemIndex) => itemIndex !== index),
                      )
                    }
                  >
                    <Trash2 size={16} /> Remove student
                  </Button>
                </div>
              )}
            </div>
          ))}

          {exportError && <p className="text-sm text-red-600">{exportError}</p>}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() =>
                setResults((current) => [...current, emptyQuizReportResult()])
              }
            >
              <Plus size={16} /> Add student
            </Button>
            <Button type="submit" disabled={exporting}>
              <Download size={16} />
              {exporting ? "Exporting..." : "Download Excel report"}
            </Button>
          </div>
        </form>
      </Card>
    </>
  );
}

export function TeacherAnalyticsPage() {
  return (
    <>
      <PageHeader title="Analytics" subtitle="Class trends, resource usage and assessment health." />
      <div className="grid gap-6 lg:grid-cols-2"><Card><h2 className="mb-4 font-semibold">Class trend</h2><PerformanceLineChart /></Card><Card><h2 className="mb-4 font-semibold">Performance distribution</h2><DistributionChart /></Card></div>
    </>
  );
}

export { AIQuizGeneratorPage as TeacherAIQuizGeneratorPage, NotificationsPage as TeacherNotificationsPage, ProfilePage as TeacherProfilePage, SettingsPage as TeacherSettingsPage };
