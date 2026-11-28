export const projectSeeds = [
  ["Voice", "db968586-961f-4e22-a8a6-ee20a9089aea"],
  ["Retorno", "dd58e468-6a03-481e-b3d4-32ec69ceabc3"],
  ["ship", "ba18741b-c4f4-4ea1-a5ed-47de2db3046e"],
  ["Volunteers", "1ed6f3d4-9c94-4d67-8b70-7c768b1dc952"],
  ["LudenLabsSite", "079aa2fb-8e3a-4744-b5d8-817e004a2127"],
  ["invoice", "180029ec-80f7-4993-a952-323f9b8b4727"],
  ["Menagment", "287e1dbc-8d3f-405c-a2ad-03839caadee7"],
  ["Enola", "7bd26229-c65b-4a33-af5e-03d37d51488b"],
  ["BOOK OF LIFE", "6925226d-4fb0-4eed-a522-d3275cec4c67"],
  ["School Analytics", "274faa8b-c241-4c76-94db-85888a4b43e1"],
  ["Museum-Zion-Friends", "c716d550-18bc-4718-97d1-c06f131a967b"],
  ["QMA", "9f9a0d20-247c-4b6b-8650-c182edc40892"],
  ["Support", "1a6a83c0-0bd4-4ae2-b9a1-dfbfb016bda5"],
  ["ClinIvue", "2798649a-3bed-40a7-902d-04cc63d4bde3"],
  ["onroter", "c6bf82ca-37ce-4e78-9f1a-4cfb941460e9"],
  ["BGU Entrepreneurship", "4fc30268-8949-42aa-89f9-3be8638688ac"],
] as const;

// Short descriptions verified against the linked repositories' README or GitHub description.
export const initialProjectDescriptions: Record<string, string> = {
  Voice: "Платформа для учителей и учеников с анализом чтения. Включает интерфейсы по ролям, API и сервис оценки чтения.",
  ship: "Harbor Quest — игровая платформа для изучения Мишны: уроки и викторины в классе связаны с домашней практикой, наградами и соревнованием между классами.",
  Retorno: "Продукт с мобильным приложением, административной панелью и API. В репозитории также есть библиотека документов и отдельный интерактивный 3D-сценарий.",
  LudenLabsSite: "Интерактивный сайт-портфолио Luden Labs: тематические миры, проекты и истории о работе команды.",
  Menagment: "Telegram-бот для рабочих групп: встречи Google Meet, сводки и административная панель по истории коммитов сотрудников.",
  Enola: "Мобильное приложение организации Yad Tamar помогает координаторам семей управлять задачами волонтёров. В проекте также есть сервер и административная панель.",
  "Museum-Zion-Friends": "Приложение для посетителей и гидов музея Friends of Zion с административной панелью и серверными сервисами для профилей, сессий и тура.",
  QMA: "Платформа качества школы: короткие опросы учителей, карта показателей и процесс улучшений. Есть приложение для учителей и руководителей, API и панель команды продукта.",
  Support: "Сервис поддержки, связывающий WhatsApp и Linear: классифицирует обращения, создаёт задачи поддержки и отправляет согласованные ответы.",
  ClinIvue: "Платформа для психологов в Израиле: помогает фиксировать наблюдения во время сессии и собирать черновик психодиагностического отчёта.",
  "BGU Entrepreneurship": "Учебная платформа курса предпринимательства BGU: видео, практические задания, обратная связь от студентов и ИИ-наставника, личное портфолио работ.",
};

export function initialProjectForRepository(repository: string): string | undefined {
  const repo = repository.split("/").pop()?.toLowerCase() || "";
  const exact: Record<string, string> = {
    "joke_bote": "Menagment", "luden-labs-site": "LudenLabsSite", "luden-labs-website": "LudenLabsSite",
    "ship-backend": "ship", "harbor-quest": "ship", "bookoflife": "BOOK OF LIFE", "bookoflifev2": "BOOK OF LIFE",
    "foz-companion": "Museum-Zion-Friends", "museum-api": "Museum-Zion-Friends", "museum-front": "Museum-Zion-Friends",
    "qma-platform": "QMA", "support-hub": "Support", "support_system_whatsup_liniear": "Support",
    "clinvue": "ClinIvue", "onroter-international": "onroter", "bgu-entrepreneurship": "BGU Entrepreneurship",
  };
  if (exact[repo]) return exact[repo];
  if (repo.startsWith("voice-")) return "Voice";
  if (repo.startsWith("retorno-")) return "Retorno";
  if (repo.startsWith("volunteers-")) return "Volunteers";
  if (repo.startsWith("enola")) return "Enola";
  return undefined;
}
