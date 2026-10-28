---
name: federal-regulations-guide
description: Research rulemaking history, codified CFR text, and public comments with regulations_* tools. Use when tracing a rule across sources, finding the publication behind a CFR source note, checking comment deadlines, or assessing public-comment evidence.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.0"
---

## Scope

Use the Federal Register for published proposals, final rules, notices, and presidential documents; eCFR for codified regulatory text at a current or historical date; and Regulations.gov for docket records and public comments. A proposal or final-rule publication alone does not establish what the CFR says at the date being researched.

Federal Register and eCFR research is keyless. Docket and comment retrieval needs REGULATIONS_GOV_API_KEY. Without it, continue with published documents, their embedded comment metadata, and CFR text; identify the comment evidence you could not inspect.

The server reads records. It neither submits comments nor downloads and parses attachment files. Statutes and court decisions require other sources.

## Identifiers

| Handle | Obtain it from | Use it for |
|:-------|:---------------|:-----------|
| FR document number | documentNumber in regulations_search_rules or regulations_list_open_comments; frDocNum on a regulations_get_docket document | Open the publication with regulations_get_document, or locate its comments with regulations_find_comments |
| Printed docket number | docketIds on Federal Register results or document detail | Find related Federal Register publications with regulations_search_rules; this is not necessarily a Regulations.gov docket ID |
| RIN | regulationIdNumbers on Federal Register results or detail | Follow related rulemaking publications with regulations_search_rules |
| Regulations.gov docket ID | regulationsGovDocketId on discovery results; docketId on regulations_get_document | Read the docket or list docket-wide comments |
| Regulations.gov document ID | regulationsGovDocumentId on Federal Register results or detail; documentId in a docket | List comments on that document |
| Document object ID | objectId on a document in regulations_get_docket | List comments on that document; do not substitute a docket's or comment's object ID |
| Comment ID | commentId in regulations_find_comments list results | Read that comment's body, status, and attachment URLs |
| CFR location | cfrReferences supplies title and part; regulations_browse_cfr supplies sections and complete appendix identifiers | Read codified text with regulations_get_cfr_section |

## Gates

1. **Choose the comment scope before retrieving evidence.** Document comments concern one publication; docket-wide comments can span several documents. Treat a docket named like `<AGENCY>_FRDOC_0001` as a warning to prefer the document-specific handle for that publication's comments. Null Regulations.gov handles mean that link is unavailable, not that nobody commented.

2. **Read comments before characterizing their arguments.** A list supplies neither bodies nor attachment details. Open individual comment records. When attachmentOnly is true, retrieve and read the attachment separately before summarizing its substance; a stub body is not the submission. Preserve withdrawn or restricted status and report duplicateComments separately from the number of records inspected; do not infer a total submission count from it.

3. **Establish coverage before asserting absence or completeness.** Inspect scope, filters, pagination, and truncation notices. An empty comment list establishes only that the requested scope and filters returned none. Broaden from a document to its rulemaking docket when appropriate. For CFR search, read sourceScope and countBasis: a section_versions count is not a count of distinct sections. A missing or partial result is not evidence that no regulation or public reaction exists.

4. **Finish the relevant text before quoting a conclusion from it.** Federal Register bodies and CFR reads return text windows. Follow the returned next offset when the answer depends on text beyond the window. A whole-part read does not inline appendix bodies. Single-section reads omit enclosing part, subpart, and subject-group Authority and Source notes; read the whole part when those notes matter.

5. **Keep dates attached to conclusions.** Use the date returned with CFR text. Historical reads start in 2017, and current text can trail today's date. Do not substitute today's date for the title's available snapshot or infer earlier text outside coverage. A paragraph cite reads its whole section; inspect the requested paragraph within that text.

6. **Resolve appendix names before reading them.** Copy the complete appendix identifier from regulations_browse_cfr or a whole-part read, including wording such as “Appendix A-1 to Part 50.” Include the returned part to keep the lookup scoped to the discovered location.

7. **Check related publications before advising on a comment deadline.** Treat commentsCloseOn as metadata for that publication, and check related publications before relying on it as the current deadline. Search the complete RIN or printed docket number for related publications and read relevant extensions. The closing day is inclusive in US Eastern time; null comment-period status means unknown. Include notices when the task concerns all opportunities for public comment, since the default open-comment listing covers proposed and final rules.

## Workflows

### Trace a rulemaking into codified text

Discover the publication with regulations_search_rules and open it with regulations_get_document. Follow its complete RIN or printed docket number to locate related proposals, final rules, corrections, or extensions. Verify each candidate's identity and substance rather than assuming similar titles establish a relationship. Use the affected CFR title and part to browse the relevant sections, then read the CFR snapshot needed for the question. Keep the published rule and codified text separately cited.

### Work backward from a CFR requirement

Search codified text with regulations_browse_cfr or start from a known cite. Read the section and, when needed, its enclosing Authority and Source notes. Take a Federal Register page citation together with the date printed beside it to regulations_search_rules. A cited page may fall inside a publication, and several publications can share a page; open the candidates before attributing the amendment. This server's page-citation lookup starts in 1994. Check the returned coverage notice before interpreting an unresolved older citation as evidence the publication is absent.

### Assess public comments

For one known publication, regulations_find_comments can resolve its FR number directly. Use regulations_get_docket when the task needs supporting materials, several rule documents, or the wider docket context. Select the relevant document handles or the docket-wide scope, then open comment details and relevant attachments. State which scope, filters, and records support the assessment; do not treat an initial page as representative of the entire corpus.

### Retrieve a large result set

Follow continuation metadata. When Federal Register navigation is capped, divide publication dates into smaller windows. For comments, divide posted dates into smaller windows; for docket documents, narrow document types. Deduplicate records where windows overlap. If a slice still exceeds the reachable window, report the remaining gap rather than claiming complete retrieval.

Start with ordinary search terms and inspect sourceScope. Do not assume the same Boolean or quoted-phrase syntax works across all three sources.
