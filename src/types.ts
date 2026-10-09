export interface Member {
  phone: string;
  name: string;
  isAdmin: boolean;
}

export interface Extraction {
  groupId: string;
  groupName: string;
  extractedAt: string;
  members: Member[];
}

export interface DiffResult {
  groupId: string;
  groupName: string;
  before: string;
  after: string;
  added: Member[];
  removed: Member[];
}

export interface ExportedMessage {
  id: string;
  timestamp: string;    // ISO 8601
  sender: string;       // phone (E.164 without '+'); empty for own messages if unknown
  senderName: string;
  fromMe: boolean;
  type: string;         // whatsapp-web.js MessageTypes value, e.g. "chat", "image"
  body: string;
  hasMedia: boolean;
  mediaFile?: string;   // path relative to the export file, when media was downloaded
}

export interface ChatExport {
  chatId: string;
  chatName: string;
  isGroup: boolean;
  exportedAt: string;   // ISO 8601
  messages: ExportedMessage[];
}
