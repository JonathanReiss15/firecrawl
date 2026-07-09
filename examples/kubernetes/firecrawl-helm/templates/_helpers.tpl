{{/*
Return the name of the chart.
*/}}
{{- define "firecrawl.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Return the fully qualified name of the chart.
*/}}
{{- define "firecrawl.fullname" -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{/*
Resolve and validate the NuQ deployment mode. "mixed" keeps PG consumers for
unflagged and draining teams while also running FDB consumers.
*/}}
{{- define "firecrawl.nuqMode" -}}
{{- $mode := default "pg" .Values.nuq.mode -}}
{{- if not (has $mode (list "pg" "mixed" "fdb")) -}}
{{- fail "nuq.mode must be one of: pg, mixed, fdb" -}}
{{- end -}}
{{- $mode -}}
{{- end -}}

{{- define "firecrawl.fdbEnabled" -}}
{{- if ne (include "firecrawl.nuqMode" .) "pg" -}}true{{- end -}}
{{- end -}}

{{- define "firecrawl.pgEnabled" -}}
{{- if ne (include "firecrawl.nuqMode" .) "fdb" -}}true{{- end -}}
{{- end -}}

{{- define "firecrawl.validateNuqTopology" -}}
{{- range $key := list "NUQ_BACKEND" "FDB_CLUSTER_FILE" "NUQ_FDB_WORKER_MODE" -}}
  {{- if hasKey $.Values.config.extra $key -}}
    {{- fail (printf "config.extra.%s is managed by nuq.mode and cannot be overridden" $key) -}}
  {{- end -}}
{{- end -}}
{{- if include "firecrawl.fdbEnabled" . -}}
  {{- if not .Values.nuqFdb.clusterFile.existingSecret -}}
    {{- fail "nuqFdb.clusterFile.existingSecret is required for mixed and fdb modes" -}}
  {{- end -}}
  {{- if lt (int .Values.nuqFdb.maintenanceWorker.replicaCount) 1 -}}
    {{- fail "nuqFdb.maintenanceWorker.replicaCount must be at least 1" -}}
  {{- end -}}
  {{- if lt (int .Values.nuqFdb.crawlFinishedWorker.replicaCount) 1 -}}
    {{- fail "nuqFdb.crawlFinishedWorker.replicaCount must be at least 1" -}}
  {{- end -}}
{{- end -}}
{{- end -}}
