import { afterAll } from "vitest";
import { testDatabase } from "./db";

// テストファイルごとの DB（test/db.ts）を、ファイルの最後に閉じて消す
afterAll(() => testDatabase.cleanup());
