import { z } from "zod";

/** 購読に付ける表示名。null で配信元の名前に戻す */
export const FeedDisplayNameInput = z.string().trim().min(1).max(200).nullable();
