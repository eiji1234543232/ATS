// =====================================================
// lib/api.js — Supabase接続層
// ここを変更するだけで将来別バックエンドに切り替え可能
// =====================================================

const SUPABASE_URL  = "https://tswllorhmpcvpxtseiia.supabase.co";
const SUPABASE_ANON = "sb_publishable_bm8D0FMVn11fp-loyKssag_GC6anPR1";

// =====================================================
// 認証ヘルパー
// =====================================================
function getToken() {
  return localStorage.getItem("ats_token") || "";
}

function getCurrentUser() {
  try {
    return JSON.parse(localStorage.getItem("ats_user") || "null");
  } catch {
    return null;
  }
}

function isLoggedIn() {
  return !!getToken();
}

function requireAuth() {
  if (!isLoggedIn()) {
    window.location.href = "index.html";
  }
}

// =====================================================
// 低レイヤー — Supabase REST API
// 将来別バックエンドに移行する場合はこの中だけ変更
// =====================================================
const sb = {

  // 認証：ログイン
  async login(email, password) {
    const res = await fetch(
      `${SUPABASE_URL}/auth/v1/token?grant_type=password`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": SUPABASE_ANON
        },
        body: JSON.stringify({ email, password })
      }
    );
    const data = await res.json();
    if (data.access_token) {
      localStorage.setItem("ats_token", data.access_token);
      localStorage.setItem("ats_refresh", data.refresh_token);
      localStorage.setItem("ats_user", JSON.stringify(data.user));
    }
    return data;
  },

  // 認証：ログアウト
  async logout() {
    await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${getToken()}`,
        "apikey": SUPABASE_ANON
      }
    });
    localStorage.removeItem("ats_token");
    localStorage.removeItem("ats_refresh");
    localStorage.removeItem("ats_user");
  },

  // 認証：トークンリフレッシュ
  async refresh() {
    const refreshToken = localStorage.getItem("ats_refresh");
    if (!refreshToken) return null;
    const res = await fetch(
      `${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": SUPABASE_ANON
        },
        body: JSON.stringify({ refresh_token: refreshToken })
      }
    );
    const data = await res.json();
    if (data.access_token) {
      localStorage.setItem("ats_token", data.access_token);
      localStorage.setItem("ats_refresh", data.refresh_token);
    }
    return data;
  },

  // 共通フェッチ（401時は自動リフレッシュ）
  async _fetch(url, options = {}, retry = true) {
    const res = await fetch(url, {
      ...options,
      headers: {
        "Authorization": `Bearer ${getToken()}`,
        "apikey": SUPABASE_ANON,
        ...options.headers
      }
    });
    // トークン期限切れなら1回だけリフレッシュして再試行
    if (res.status === 401 && retry) {
      const refreshed = await sb.refresh();
      if (refreshed?.access_token) {
        return sb._fetch(url, options, false);
      }
      // リフレッシュも失敗 → ログイン画面へ
      localStorage.removeItem("ats_token");
      window.location.href = "index.html";
      return null;
    }
    return res;
  },

  // SELECT
  async query(table, params = {}) {
    let url = `${SUPABASE_URL}/rest/v1/${table}?`;
    if (params.select) url += `select=${encodeURIComponent(params.select)}&`;
    if (params.filter) url += `${params.filter}&`;
    if (params.order)  url += `order=${params.order}&`;
    if (params.limit)  url += `limit=${params.limit}&`;
    if (params.offset) url += `offset=${params.offset}&`;

    const res = await sb._fetch(url, {
      headers: { "Prefer": "count=exact" }
    });
    if (!res) return [];
    return res.json();
  },

  // INSERT
  async insert(table, data) {
    const res = await sb._fetch(
      `${SUPABASE_URL}/rest/v1/${table}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Prefer": "return=representation"
        },
        body: JSON.stringify(data)
      }
    );
    if (!res) return null;
    return res.json();
  },

  // UPDATE（idで対象を特定）
  async update(table, id, data, idColumn = "id") {
    const res = await sb._fetch(
      `${SUPABASE_URL}/rest/v1/${table}?${idColumn}=eq.${id}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "Prefer": "return=representation"
        },
        body: JSON.stringify(data)
      }
    );
    if (!res) return null;
    return res.json();
  },

  // 論理削除
  async softDelete(table, id) {
    return sb.update(table, id, { deleted_at: new Date().toISOString() });
  },

  // ファイルアップロード
  async uploadFile(bucket, path, file) {
    const res = await sb._fetch(
      `${SUPABASE_URL}/storage/v1/object/${bucket}/${path}`,
      {
        method: "POST",
        headers: { "Content-Type": file.type },
        body: file
      }
    );
    if (!res) return null;
    return res.json();
  },

  // 署名付きURL取得（ファイルダウンロード用・1時間有効）
  async getSignedUrl(bucket, path) {
    const res = await sb._fetch(
      `${SUPABASE_URL}/storage/v1/object/sign/${bucket}/${path}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expiresIn: 3600 })
      }
    );
    if (!res) return null;
    const data = await res.json();
    return `${SUPABASE_URL}/storage/v1${data.signedURL}`;
  }
};

// =====================================================
// 高レイヤー — ATS専用API
// 画面側はここを呼ぶだけ。sbの中身が変わっても影響なし
// =====================================================
const atsApi = {

  // ---------- 認証 ----------
  async login(email, password) {
    const data = await sb.login(email, password);
    if (!data.access_token) return { error: data.error_description || "ログインに失敗しました" };

    // profilesからロール情報を取得
    const profiles = await sb.query("profiles", {
      select: "id,email,name,role",
      filter: `id=eq.${data.user.id}`
    });
    if (profiles && profiles[0]) {
      const user = { ...data.user, ...profiles[0] };
      localStorage.setItem("ats_user", JSON.stringify(user));
    }
    return { success: true };
  },

  async logout() {
    await sb.logout();
  },

  // ---------- 応募者 ----------
  async getApplicants(filters = {}) {
    let filter = "deleted_at=is.null";
    if (filters.step)    filter += `&step=eq.${filters.step}`;
    if (filters.status)  filter += `&status=eq.${filters.status}`;
    if (filters.job_id)  filter += `&job_id=eq.${filters.job_id}`;
    if (filters.gender)  filter += `&gender=eq.${filters.gender}`;
    if (filters.date_from) filter += `&applied_at=gte.${filters.date_from}`;
    if (filters.date_to)   filter += `&applied_at=lte.${filters.date_to}`;
    if (filters.keyword) {
      // 氏名・ID・メールで検索
      filter += `&or=(name.ilike.*${filters.keyword}*,id.ilike.*${filters.keyword}*,email.ilike.*${filters.keyword}*)`;
    }
    return sb.query("applicants", {
      select: "*",
      filter,
      order: "applied_at.desc,created_at.desc",
      limit: filters.limit || 200
    });
  },

  async getApplicant(id) {
    const rows = await sb.query("applicants", {
      select: "*",
      filter: `id=eq.${id}&deleted_at=is.null`
    });
    return rows?.[0] || null;
  },

  async createApplicant(data) {
    const user = getCurrentUser();
    return sb.insert("applicants", { ...data, created_by: user?.id });
  },

  async updateApplicant(id, data) {
    return sb.update("applicants", id, data);
  },

  async deleteApplicant(id) {
    return sb.softDelete("applicants", id);
  },

  // 一括操作
  async bulkUpdate(ids, data) {
    return Promise.all(ids.map(id => sb.update("applicants", id, data)));
  },

  // ---------- タグ ----------
  async getTags() {
    return sb.query("tags", { select: "*", order: "name.asc" });
  },

  async getApplicantTags(applicantId) {
    return sb.query("applicant_tags", {
      select: "tag_id,tags(id,name,color)",
      filter: `applicant_id=eq.${applicantId}`
    });
  },

  async addTag(applicantId, tagId) {
    return sb.insert("applicant_tags", { applicant_id: applicantId, tag_id: tagId });
  },

  async removeTag(applicantId, tagId) {
    const res = await sb._fetch(
      `${SUPABASE_URL}/rest/v1/applicant_tags?applicant_id=eq.${applicantId}&tag_id=eq.${tagId}`,
      { method: "DELETE" }
    );
    return res;
  },

  // ---------- 選考ステップ ----------
  async getStepHistory(applicantId) {
    return sb.query("step_histories", {
      select: "*, profiles(name)",
      filter: `applicant_id=eq.${applicantId}`,
      order: "created_at.asc"
    });
  },

  async addStepHistory(applicantId, step, status, note = "") {
    const user = getCurrentUser();
    return sb.insert("step_histories", {
      applicant_id: applicantId,
      step,
      status,
      note,
      changed_by: user?.id
    });
  },

  // ---------- 評価 ----------
  async getEvaluations(applicantId) {
    return sb.query("evaluations", {
      select: "*, profiles(name,role)",
      filter: `applicant_id=eq.${applicantId}`,
      order: "step.asc,created_at.asc"
    });
  },

  async saveEvaluation(data) {
    const user = getCurrentUser();
    return sb.insert("evaluations", { ...data, evaluator_id: user?.id });
  },

  async updateEvaluation(id, data) {
    return sb.update("evaluations", id, data);
  },

  // ---------- 面接官アサイン ----------
  async getAssignments(applicantId) {
    return sb.query("interviewer_assignments", {
      select: "*, profiles(id,name,role)",
      filter: `applicant_id=eq.${applicantId}`
    });
  },

  async assignInterviewer(applicantId, userId, step) {
    const user = getCurrentUser();
    return sb.insert("interviewer_assignments", {
      applicant_id: applicantId,
      user_id: userId,
      step,
      assigned_by: user?.id
    });
  },

  async removeInterviewer(applicantId, userId, step) {
    const res = await sb._fetch(
      `${SUPABASE_URL}/rest/v1/interviewer_assignments?applicant_id=eq.${applicantId}&user_id=eq.${userId}&step=eq.${step}`,
      { method: "DELETE" }
    );
    return res;
  },

  // ---------- 書類 ----------
  async getFiles(applicantId) {
    return sb.query("files", {
      select: "*",
      filter: `applicant_id=eq.${applicantId}`,
      order: "created_at.asc"
    });
  },

  async uploadFile(applicantId, file) {
    const user = getCurrentUser();
    const path = `${applicantId}/${Date.now()}_${file.name}`;
    const uploaded = await sb.uploadFile("applicant-files", path, file);
    if (!uploaded) return null;
    return sb.insert("files", {
      applicant_id: applicantId,
      name: file.name,
      file_type: file.name.split(".").pop().toUpperCase(),
      storage_path: path,
      size_bytes: file.size,
      uploaded_by: user?.id
    });
  },

  async getFileUrl(storagePath) {
    return sb.getSignedUrl("applicant-files", storagePath);
  },

  // ---------- メール ----------
  async getMailTemplates() {
    return sb.query("mail_templates", { select: "*", order: "created_at.asc" });
  },

  async getMailHistory(applicantId) {
    return sb.query("mail_logs", {
      select: "*, mail_templates(name), profiles(name)",
      filter: `applicant_id=eq.${applicantId}`,
      order: "sent_at.desc"
    });
  },

  async logMail(applicantId, templateId, subject, sentTo) {
    const user = getCurrentUser();
    return sb.insert("mail_logs", {
      applicant_id: applicantId,
      template_id: templateId,
      subject,
      sent_to: sentTo,
      sent_by: user?.id,
      status: "sent"
    });
  },

  // ---------- 社内連絡タイムライン ----------
  async getTimeline(applicantId) {
    return sb.query("timeline_entries", {
      select: "*",
      filter: `applicant_id=eq.${applicantId}`,
      order: "created_at.desc"
    });
  },

  async postTimeline(applicantId, type, text) {
    const user = getCurrentUser();
    return sb.insert("timeline_entries", {
      applicant_id: applicantId,
      user_id: user?.id,
      user_name: user?.name || user?.email || "管理者",
      type,
      text
    });
  },

  async deleteTimeline(id) {
    const res = await sb._fetch(
      `${SUPABASE_URL}/rest/v1/timeline_entries?id=eq.${id}`,
      { method: "DELETE" }
    );
    return res;
  },

  // ---------- 求人 ----------
  async getJobs() {
    return sb.query("jobs", {
      select: "id,title,department,status",
      filter: "deleted_at=is.null",
      order: "created_at.asc"
    });
  },

  // ---------- メンバー ----------
  async getMembers() {
    return sb.query("profiles", {
      select: "id,name,email,role",
      filter: "is_active=eq.true",
      order: "name.asc"
    });
  }
};
