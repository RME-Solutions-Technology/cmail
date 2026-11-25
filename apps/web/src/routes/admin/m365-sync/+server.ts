import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

// This page moved into the one Microsoft 365 page; old links and bookmarks land on its section.
export const GET: RequestHandler = () => redirect(301, '/admin/microsoft-365#directory-sync');
