import { describe, expect, it } from "vitest";
import type { Env } from "../../lib/env";
import * as account from "../../lib/db/account";
import * as authors from "../../lib/db/authors";
import * as favorites from "../../lib/db/favorites";
import * as photos from "../../lib/db/photos";
import * as tags from "../../lib/db/tags";

const surface: Record<string, [Record<string, unknown>, string[]]> = {
  photos: [photos, ["listPhotoPage", "countPhotos", "getPhotoDetail", "resolvePage"]],
  authors: [authors, ["listAuthorsWithPhotos", "getAuthorByUsername", "listAuthorPhotoPage"]],
  tags: [tags, ["listAllTags", "listTagPhotoPage", "countPhotosByTag"]],
  favorites: [favorites, ["getFavoriteState", "setFavoriteState", "addFavorite", "removeFavorite", "listFavoritePage", "countUserFavorites", "countFavoritesForPhoto"]],
  account: [account, ["updateUsername", "updateAvatarKey", "collectAccountObjectKeys", "deleteAccountRows"]],
};

describe("lib/db public surface", () => {
  for (const [moduleName, [namespace, names]] of Object.entries(surface)) {
    it.each(names)(`${moduleName} exports %s`, (name) => {
      expect(typeof namespace[name]).toBe("function");
    });
  }
});

// Never called: this keeps the downstream call signatures checked by tsc.
export async function __typeOnly(db: D1Database) {
  const env = { DB: db } as Env;
  return {
    page: await photos.listPhotoPage(env, 1),
    detail: await photos.getPhotoDetail(env, 1),
    authors: await authors.listAuthorsWithPhotos(env),
    author: await authors.getAuthorByUsername(env, "alice"),
    authorPage: await authors.listAuthorPhotoPage(env, 1, 1),
    tags: await tags.listAllTags(env),
    tagPage: await tags.listTagPhotoPage(env, 1, 1),
    tagCount: await tags.countPhotosByTag(env, 1),
    favorite: await favorites.getFavoriteState(env, 1, 1),
    favoritePage: await favorites.listFavoritePage(env, 1, 1),
    favoriteCount: await favorites.countUserFavorites(env, 1),
    photoFavoriteCount: await favorites.countFavoritesForPhoto(env, 1),
    favoriteSet: await favorites.setFavoriteState(env, 1, 1, "favorited"),
    rename: await account.updateUsername(env, 1, "alice"),
    avatar: await account.updateAvatarKey(env, 1, null),
    objectKeys: await account.collectAccountObjectKeys(env, 1),
    deleted: await account.deleteAccountRows(env, 1),
  };
}
