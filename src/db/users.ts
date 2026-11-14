import { and, eq, ne, sql } from "drizzle-orm";
import type { Database } from ".";
import { identities, type User, users } from "./schema";

/** 提供元が確かめた、ログインした人。email は提供元が確認済みとしたもの */
export type VerifiedLogin = { issuer: string; subject: string; email: string };

/** 提供元の ID（issuer と subject）に結び付いたユーザー */
async function findLinkedUser(
  db: Database,
  login: Pick<VerifiedLogin, "issuer" | "subject">,
): Promise<{ user: User; identityId: string; identityEmail: string } | undefined> {
  return db
    .select({ user: users, identityId: identities.id, identityEmail: identities.email })
    .from(identities)
    .innerJoin(users, eq(identities.userId, users.id))
    .where(and(eq(identities.issuer, login.issuer), eq(identities.subject, login.subject)))
    .get();
}

/**
 * 提供元でログインした人を、ユーザーに結び付ける（docs/decisions/accounts.md の 3、4）。
 *
 * 1. その提供元の ID がすでに結び付いていれば、そのユーザー（提供元の側でメールが変わっても同じ）
 * 2. なければ、確認済みのメールが一致するユーザーに結び付ける
 * 3. それもなければ、ユーザーを作って結び付ける
 *
 * ユーザーになれるのは、メールが許可したもの（isAllowed）の人だけ。結び付いたあとも、ログインの
 * たびにそのユーザーのメールで確かめるので、許可から外せばログインできなくなる。
 *
 * 2 と 3 は「なければ作る」「なければ結び付ける」を一意制約と ON CONFLICT DO NOTHING で行い、
 * 最後に結び付いたユーザーを読み直す。同じ人が同時にログインしても、ユーザーも結び付きも 1 つになる。
 * @returns ユーザー。許可したメールでなければ undefined
 */
export async function resolveLoginUser(
  db: Database,
  input: { login: VerifiedLogin; isAllowed: (email: string) => boolean; now: Date },
): Promise<User | undefined> {
  const { issuer, subject } = input.login;
  const email = input.login.email.toLowerCase();

  const linked = await findLinkedUser(db, input.login);
  if (linked) {
    if (!input.isAllowed(linked.user.email)) return undefined;
    // 最後にログインしたときに、提供元が確認済みとしたメールを残す（変わったときだけ書く）
    if (linked.identityEmail !== email) {
      await db
        .update(identities)
        .set({ email })
        .where(and(eq(identities.id, linked.identityId), ne(identities.email, email)))
        .run();
    }
    return linked.user;
  }

  if (!input.isAllowed(email)) return undefined;
  await db
    .insert(users)
    .values({ id: crypto.randomUUID(), email, createdAt: input.now })
    .onConflictDoNothing()
    .run();
  await db.run(sql`
    insert into ${identities}
      (${sql.identifier("id")}, ${sql.identifier("user_id")}, ${sql.identifier("issuer")},
       ${sql.identifier("subject")}, ${sql.identifier("email")}, ${sql.identifier("created_at")})
    select ${crypto.randomUUID()}, ${users.id}, ${issuer}, ${subject}, ${email}, ${input.now.getTime()}
    from ${users}
    where ${users.email} = ${email}
    on conflict do nothing
  `);

  const result = await findLinkedUser(db, input.login);
  return result && input.isAllowed(result.user.email) ? result.user : undefined;
}
