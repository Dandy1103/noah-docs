import { NoahPageHeadingComponent } from '@dandy1103/ui';
import { DatePipe } from '@angular/common';
import { Component, DestroyRef, inject, signal } from '@angular/core';
import { sendToLogin } from '../../require-session';

interface DocumentItem {
  id: string;
  name: string;
  sizeBytes: number;
  createdAt: string;
}

interface DocumentList {
  documents: DocumentItem[];
  csrfToken: string;
}

const API = '/api/documents';
const MAX_BYTES = 20 * 1024 * 1024;
const EXTENSIONS = '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.png,.jpg,.jpeg,.gif,.webp';

class DocumentRequestError extends Error {
  constructor(readonly status: number) {
    super(`Document request failed (${status})`);
  }
}

@Component({
  selector: 'app-home',
  standalone: true,
  imports: [DatePipe, NoahPageHeadingComponent],
  templateUrl: './home.component.html',
  styleUrl: './home.component.scss',
})
export class HomeComponent {
  private readonly abort = new AbortController();
  private uploadRequest?: XMLHttpRequest;
  private csrfToken = '';

  readonly allowedExtensions = EXTENSIONS;
  readonly documents = signal<DocumentItem[]>([]);
  readonly selection = signal<{ file: File; id: string } | null>(null);
  readonly loading = signal(true);
  readonly ready = signal(false);
  readonly busy = signal(false);
  readonly progress = signal<number | null>(null);
  readonly error = signal('');
  readonly notice = signal('');

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.abort.abort();
      this.uploadRequest?.abort();
    });
    void this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      const response = await this.request(API);
      const list: DocumentList = await response.json();
      this.csrfToken = list.csrfToken;
      this.documents.set(list.documents);
      this.ready.set(true);
    } catch (error) {
      this.ready.set(false);
      await this.report(error, '無法載入文件。請稍後再試。');
    } finally {
      this.loading.set(false);
    }
  }

  select(input: HTMLInputElement): void {
    this.selection.set(null);
    this.error.set('');
    this.notice.set('');
    const file = input.files?.item(0);
    if (!file) return;
    const extension = file.name.match(/.+(\.[^.]+)$/)?.[1].toLowerCase();
    if (!file.size || file.size > MAX_BYTES || !extension || !EXTENSIONS.split(',').includes(extension)) {
      this.error.set('請選擇支援的文件或圖片。檔案須大於 0 且不超過 20 MB。');
      input.value = '';
      return;
    }
    this.selection.set({ file, id: crypto.randomUUID() });
  }

  async upload(input: HTMLInputElement): Promise<void> {
    const selected = this.selection();
    if (!selected || this.busy() || !this.ready()) return;
    this.start();
    this.progress.set(0);
    try {
      const item = await this.sendFile(selected.file, selected.id);
      this.documents.update(items => [item, ...items.filter(existing => existing.id !== item.id)]);
      this.selection.set(null);
      input.value = '';
      this.notice.set(`已上傳「${item.name}」。`);
    } catch (error) {
      await this.report(error, '無法確認上傳結果。你可以使用同一個檔案重試。');
    } finally {
      this.uploadRequest = undefined;
      this.progress.set(null);
      this.busy.set(false);
    }
  }

  async download(item: DocumentItem): Promise<void> {
    if (this.busy()) return;
    this.start();
    try {
      const response = await this.request(`${API}/${item.id}/download`);
      const { url }: { url: string } = await response.json();
      window.location.assign(url);
    } catch (error) {
      await this.report(error, '下載失敗。請稍後再試。');
    } finally {
      this.busy.set(false);
    }
  }

  async remove(item: DocumentItem): Promise<void> {
    if (this.busy() || !window.confirm(`確定要刪除「${item.name}」？`)) return;
    this.start();
    try {
      const response = await this.request(`${API}/${item.id}`, {
        method: 'DELETE', headers: { 'X-CSRF-TOKEN': this.csrfToken },
      });
      this.documents.update(items => items.filter(existing => existing.id !== item.id));
      this.notice.set(response.status === 202 ? '已送出刪除，系統會繼續處理。' : `已刪除「${item.name}」。`);
    } catch (error) {
      await this.report(error, '無法確認刪除結果。請重新整理列表後再試。');
    } finally {
      this.busy.set(false);
    }
  }

  fileSize(bytes: number): string {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${bytes} B`;
  }

  private start(): void {
    this.busy.set(true);
    this.error.set('');
    this.notice.set('');
  }

  private async request(url: string, options?: RequestInit): Promise<Response> {
    const response = await fetch(url, { ...options, signal: this.abort.signal, cache: 'no-store' });
    if (!response.ok) throw new DocumentRequestError(response.status);
    return response;
  }

  private sendFile(file: File, id: string): Promise<DocumentItem> {
    const form = new FormData();
    form.append('id', id);
    form.append('file', file);
    return new Promise((resolve, reject) => {
      const request = this.uploadRequest = new XMLHttpRequest();
      request.open('POST', API);
      request.responseType = 'json';
      request.setRequestHeader('X-CSRF-TOKEN', this.csrfToken);
      request.upload.onprogress = event => {
        if (event.lengthComputable) this.progress.set(Math.round(event.loaded * 100 / event.total));
      };
      request.onerror = request.onabort = () => reject(new Error('Upload interrupted'));
      request.onload = () => {
        if (request.status !== 201 || !request.response?.id) {
          reject(new DocumentRequestError(request.status));
          return;
        }
        resolve(request.response as DocumentItem);
      };
      request.send(form);
    });
  }

  private async report(error: unknown, fallback: string): Promise<void> {
    if (this.abort.signal.aborted) return;
    const status = error instanceof DocumentRequestError ? error.status : 0;
    switch (status) {
      case 401:
        sendToLogin();
        return;
      case 403:
        if (this.ready()) await this.load();
        if (this.ready()) this.error.set('操作驗證已更新，請再試一次。');
        else if (!this.error()) this.error.set('目前沒有文件存取權限。');
        return;
      case 404:
        this.error.set('找不到文件。若文件已刪除，請重新整理列表。');
        return;
      case 400:
        this.error.set('檔案或檔名無法使用，請重新選擇。');
        return;
      case 409:
        this.error.set('這次上傳已失效，請重新選擇檔案。');
        return;
      case 413:
        this.error.set('檔案超過 20 MB。');
        return;
      case 415:
        this.error.set('不支援這個檔案格式。');
        return;
      case 503:
        this.error.set('文件儲存目前無法使用，請稍後再試。');
        return;
      default:
        this.error.set(fallback);
    }
  }
}
