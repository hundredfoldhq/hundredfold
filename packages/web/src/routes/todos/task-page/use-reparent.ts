import { useMutation, useQueryClient } from "@tanstack/react-query"
import { api, ApiError } from "@/lib/api"
import { TODO_WRITE_KEY } from "@/lib/query-keys"
import { TODO_CACHE_ROOTS } from "@/lib/todo-caches"
import { operatorSafeTodoError } from "@/lib/todos"

/* Moving a Todo between top level and sub-task level: one write
 * (PUT /api/work-items/:id/parent) in either direction. A move changes the Todo,
 * its sub-tasks (their root and depth), both parents' children, and every tree
 * and board that shows them, so every Todo cache and every tree is refetched. */

export function useReparentWorkItem() {
  const qc = useQueryClient()
  return useMutation({
    mutationKey: TODO_WRITE_KEY,
    mutationFn: ({ id, parentId }: { id: string; parentId: string | null }) => api.reparentWorkItem(id, parentId),
    onSettled: () => {
      for (const queryKey of TODO_CACHE_ROOTS) void qc.invalidateQueries({ queryKey })
      void qc.invalidateQueries({ queryKey: ["work-item-tree"] })
    },
  })
}

/** A refusal in the gateway's own words. Every 4xx the move route sends is
 *  written for the operator ("X cannot become a sub-task of Y, which is already
 *  beneath it", "parent Todo Y is done — …", the sprint and department rules),
 *  so it says more than a generic line could. Anything else gets the fallback. */
export function reparentErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 404 && error.message.trim()) {
    return error.message
  }
  return operatorSafeTodoError(error, fallback)
}
