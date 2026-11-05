import 'express';
import type { Papel } from './papel.ts';

declare global {
  namespace Express {
    interface Request {
      user?: { id: string; perfil: 'ADMIN' | 'USUARIO' };
      validated: { params?: any; query?: any; body?: any };
      projeto?: { id: string; titulo: string; status: string; criadoPor: string; [k: string]: unknown };
      papel?: Papel | 'ADMIN';
    }
  }
}
