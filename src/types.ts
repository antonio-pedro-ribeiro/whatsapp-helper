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
